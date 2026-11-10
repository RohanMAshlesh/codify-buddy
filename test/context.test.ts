import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { chunkFile } from "../src/context/chunker.js";
import { extractImports, resolveImport } from "../src/context/graph.js";
import { ContextIndex } from "../src/context/index.js";
import { buildRepoMap } from "../src/context/repomap.js";
import { splitIdentifier, tokenize } from "../src/context/tokenize.js";
import { walkProject } from "../src/context/walker.js";
import { makeTempDir } from "./helpers.js";

const TS_SERVICE = `import { db } from "./db";
import type { User } from "../models/user";

/** Service for user accounts. */
export class UserService {
  constructor(private readonly repo: Repo) {}

  async findById(id: string): Promise<User | null> {
    return db.users.get(id);
  }

  async createUser(email: string): Promise<User> {
    const user = { id: crypto.randomUUID(), email };
    await db.users.put(user);
    return user;
  }
}

export function hashPassword(pw: string): string {
  return pw.split("").reverse().join("");
}

export const validateEmail = (email: string) => /@/.test(email);
`;

const PY = `import os
from .models import Invoice

class BillingEngine:
    def charge(self, invoice):
        return invoice.total

def refund_payment(payment_id):
    return os.getenv("REFUND") or payment_id
`;

const MD = `# Billing

Overview text.

## Refunds

Refunds are processed nightly by refund_payment.

## Invoices

Invoices are generated monthly.
`;

describe("tokenize", () => {
  it("splits identifiers and keeps compound names", () => {
    expect(splitIdentifier("getUserById")).toEqual(["get", "user", "by", "id"]);
    expect(splitIdentifier("HTTPServerError")).toEqual(["http", "server", "error"]);
    const toks = tokenize("findById user_accounts");
    expect(toks).toContain("findbyid");
    expect(toks).toContain("user");
    expect(toks).toContain("account");
  });
});

describe("chunkFile", () => {
  it("chunks TypeScript by symbol with qualified method names", () => {
    const chunks = chunkFile(TS_SERVICE, "typescript");
    const syms = chunks.map((c) => c.symbol);
    expect(syms).toContain("UserService");
    expect(syms).toContain("UserService.findById");
    expect(syms).toContain("UserService.createUser");
    expect(syms).toContain("hashPassword");
    expect(syms).toContain("validateEmail");
    const cls = chunks.find((c) => c.symbol === "UserService")!;
    expect(cls.text).toContain("/** Service for user accounts. */");
    const hp = chunks.find((c) => c.symbol === "hashPassword")!;
    expect(TS_SERVICE.split("\n")[hp.startLine - 1]).toContain("function hashPassword");
  });

  it("chunks Python classes and methods", () => {
    const syms = chunkFile(PY, "python").map((c) => c.symbol);
    expect(syms).toEqual(expect.arrayContaining(["BillingEngine", "BillingEngine.charge", "refund_payment"]));
  });

  it("chunks markdown by heading trail", () => {
    const syms = chunkFile(MD, "markdown").map((c) => c.symbol);
    expect(syms).toEqual(["Billing", "Billing > Refunds", "Billing > Invoices"]);
  });

  it("splits very long regions into windows", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkFile(long, "text");
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(400);
  });
});

describe("graph", () => {
  it("extracts and resolves relative imports", () => {
    expect(extractImports(TS_SERVICE, "typescript")).toEqual(["./db", "../models/user"]);
    const files = new Set(["src/services/db.ts", "src/models/user.ts", "src/services/user.ts"]);
    expect(resolveImport("./db", "src/services/user.ts", "typescript", files)).toBe("src/services/db.ts");
    expect(resolveImport("../models/user", "src/services/user.ts", "typescript", files)).toBe("src/models/user.ts");
    expect(resolveImport("react", "src/services/user.ts", "typescript", files)).toBeNull();
    expect(resolveImport(".models", "billing/engine.py", "python", new Set(["billing/models.py"]))).toBe("billing/models.py");
  });
});

describe("walkProject", () => {
  it("honours .gitignore, defaults, binaries and size limits", () => {
    const root = makeTempDir({
      ".gitignore": "secret.txt\n",
      "src/a.ts": "export const a = 1;",
      "src/sub/.gitignore": "generated/\n",
      "src/sub/generated/x.ts": "x",
      "src/sub/keep.ts": "k",
      "secret.txt": "s",
      "node_modules/pkg/index.js": "x",
      "big.txt": "x".repeat(2000),
    });
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
    const rels = walkProject(root, { maxFileBytes: 1000 }).map((f) => f.rel);
    expect(rels).toEqual([".gitignore", "src/a.ts", "src/sub/.gitignore", "src/sub/keep.ts"]);
  });
});

describe("ContextIndex", () => {
  const project = () =>
    makeTempDir({
      "src/services/user.ts": TS_SERVICE,
      "src/services/db.ts": "export const db = { users: new Map() };\n",
      "src/models/user.ts": "export interface User { id: string; email: string }\n",
      "billing/engine.py": PY,
      "billing/models.py": "class Invoice:\n    total = 0\n",
      "docs/billing.md": MD,
    });

  it("finds symbols by exact name and by concept", () => {
    const root = project();
    const idx = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    const stats = idx.update();
    expect(stats.added).toBe(6);

    const byName = idx.search("findById");
    expect(byName.hits[0]!.symbol).toBe("UserService.findById");
    expect(byName.hits[0]!.citation).toMatch(/^src\/services\/user\.ts:\d+-\d+$/);
    expect(byName.hits[0]!.text).toContain("db.users.get(id)");

    const concept = idx.search("how are refunds processed");
    const paths = concept.hits.map((h) => h.path);
    expect(paths).toContain("docs/billing.md");
    expect(paths).toContain("billing/engine.py");

    // Neighbours of the top hit that were not hits themselves.
    expect(byName.related).toContain("src/services/db.ts");
    expect(idx.neighbours("src/services/user.ts")).toEqual(["src/models/user.ts", "src/services/db.ts"]);
  });

  it("handles tokens that collide with Object.prototype keys", () => {
    const root = makeTempDir({
      "src/a.ts": "class A {\n  constructor() {\n    this.toString = () => 'hasOwnProperty';\n  }\n}\n",
      "constructor": "plain file named constructor\n",
    });
    const idx = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    idx.update();
    const res = idx.search("constructor toString hasOwnProperty");
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.hits.every((h) => Number.isFinite(h.score))).toBe(true);
    const reloaded = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    reloaded.load();
    expect(reloaded.search("constructor").hits.every((h) => Number.isFinite(h.score))).toBe(true);
  });

  it("updates incrementally and persists", () => {
    const root = project();
    const idx = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    idx.update();
    expect(idx.update()).toMatchObject({ added: 0, changed: 0, removed: 0 });

    fs.writeFileSync(path.join(root, "src/services/db.ts"), "export function connectDatabase() {\n  return 1;\n}\n");
    fs.rmSync(path.join(root, "billing/models.py"));
    const s = idx.update();
    expect(s).toMatchObject({ changed: 1, removed: 1 });

    const reloaded = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    expect(reloaded.load()).toBe(true);
    expect(reloaded.fileCount).toBe(5);
    expect(reloaded.search("connectDatabase").hits[0]!.path).toBe("src/services/db.ts");
    expect(fs.readFileSync(path.join(root, ".codify/.gitignore"), "utf8")).toContain("index/");
  });

  it("respects token budgets and path filters", () => {
    const root = project();
    const idx = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    idx.update();
    const filtered = idx.search("user", { pathFilter: "models/" });
    expect(filtered.hits.every((h) => h.path.startsWith("src/models/"))).toBe(true);
    const tiny = idx.search("user email", { budgetTokens: 1 });
    expect(tiny.hits.length).toBe(1);
  });

  it("builds a deterministic repo map within budget", () => {
    const root = project();
    const idx = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    idx.update();
    const map = buildRepoMap(idx, 1000);
    expect(map).toContain("src/services/user.ts: UserService, hashPassword, validateEmail");
    expect(buildRepoMap(idx, 1000)).toBe(map);
    expect(buildRepoMap(idx, 5)).toMatch(/more files/);
  });
});
