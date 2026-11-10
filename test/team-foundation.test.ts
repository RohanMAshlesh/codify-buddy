import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken, identityFromClaims, issueToken, OidcVerifier, verifyToken } from "../src/team/auth.js";
import { loadTeamConfig, TeamConfigSchema } from "../src/team/config.js";
import { canAccess, type Identity } from "../src/team/identity.js";
import { clampMode, mcpServerAllowed, modelAllowed, PolicySchema } from "../src/team/policy.js";
import { FileStore } from "../src/team/store.js";
import { makeTempDir } from "./helpers.js";
import { startMockIdp } from "./mock-idp.js";

const alice: Identity = { sub: "u1", email: "alice@acme.com", groups: ["engineering"], admin: false };

describe("policy", () => {
  it("clamps modes and checks models and MCP servers", () => {
    expect(clampMode("yolo", "auto-edit")).toBe("auto-edit");
    expect(clampMode("ask", "auto-edit")).toBe("ask");
    expect(clampMode("auto-edit", "read-only")).toBe("read-only");
    const p = PolicySchema.parse({ allowedModels: ["claude-opus-5-5"], allowedMcpServers: ["files"] });
    expect(modelAllowed("claude-opus-5-5", p)).toBe(true);
    expect(modelAllowed("claude-fable-5-2", p)).toBe(false);
    expect(modelAllowed("anything", PolicySchema.parse({}))).toBe(true);
    expect(mcpServerAllowed("files", p)).toBe(true);
    expect(mcpServerAllowed("random", p)).toBe(false);
    expect(PolicySchema.parse({})).toMatchObject({ maxPermissionMode: "auto-edit", requireGateway: true, monthlyBudgetUsd: 0, auditPrompts: false });
  });
});

describe("ACL", () => {
  it("matches everyone, groups, users and domains; empty means admins only", () => {
    expect(canAccess(alice, ["*"])).toBe(true);
    expect(canAccess(alice, ["group:engineering"])).toBe(true);
    expect(canAccess(alice, ["group:finance"])).toBe(false);
    expect(canAccess(alice, ["user:ALICE@acme.com"])).toBe(true);
    expect(canAccess(alice, ["domain:acme.com"])).toBe(true);
    expect(canAccess(alice, ["domain:other.com"])).toBe(false);
    expect(canAccess(alice, [])).toBe(false);
    expect(canAccess({ ...alice, admin: true }, [])).toBe(true);
  });
});

describe("team config", () => {
  it("loads with defaults and resolves the data dir next to the file", () => {
    const dir = makeTempDir({ "team.json": JSON.stringify({ org: "Acme", sources: [{ id: "wiki", type: "docs", path: "wiki", allow: ["*"] }] }) });
    const loaded = loadTeamConfig(path.join(dir, "team.json"));
    expect(loaded.dataDir).toBe(path.join(dir, "codify-team-data"));
    expect(loaded.config.sessionHours).toBe(168);
    expect(loaded.config.sources[0]).toMatchObject({ id: "wiki", allow: ["*"] });
    expect(() => TeamConfigSchema.parse({})).toThrow();
  });
});

describe("tokens and store", () => {
  it("issues, verifies, expires and revokes tokens stored by hash only", () => {
    const store = new FileStore(makeTempDir());
    const { token, record } = issueToken(store, alice, { kind: "pat", ttlHours: 1, label: "ci" });
    expect(token).toMatch(/^cbt_/);
    expect(verifyToken(store, token)).toEqual(alice);
    expect(verifyToken(store, "cbt_nope")).toBeNull();
    expect(verifyToken(store, token, new Date(Date.now() + 2 * 3_600_000))).toBeNull();
    const raw = fs.readFileSync(path.join(store.dir, "tokens.json"), "utf8");
    expect(raw).not.toContain(token);
    expect(raw).toContain(hashToken(token));
    expect(store.revokeToken(record.id)).toBe(1);
    expect(verifyToken(store, token)).toBeNull();
  });

  it("accumulates usage and queries the audit log", () => {
    const store = new FileStore(makeTempDir());
    store.addUsage("2026-11", "u1", alice.email, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.01 });
    const u = store.addUsage("2026-11", "u1", alice.email, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.02 });
    expect(u).toMatchObject({ requests: 2, inputTokens: 20, costUsd: 0.03 });
    store.appendAudit([
      { ts: "2026-11-10T10:00:00Z", sub: "u1", email: alice.email, type: "tool_call", tool: "run_command" },
      { ts: "2026-11-10T11:00:00Z", sub: "u2", email: "bo@acme.com", type: "turn_end" },
    ]);
    expect(store.queryAudit({ email: alice.email }).map((e) => e.type)).toEqual(["tool_call"]);
    expect(store.queryAudit({ since: "2026-11-10T10:30:00Z" })).toHaveLength(1);
    expect(new FileStore(store.dir).getUsage("2026-11", "u1")?.requests).toBe(2);
  });
});

describe("OIDC", () => {
  let idp: Awaited<ReturnType<typeof startMockIdp>>;
  beforeAll(async () => {
    idp = await startMockIdp({ sub: "okta|1", email: "alice@acme.com", name: "Alice", groups: ["engineering", "platform"] });
  });
  afterAll(() => idp.close());

  it("verifies ID tokens against the provider's keys and maps groups and admin rights", async () => {
    const config = TeamConfigSchema.parse({ org: "Acme", oidc: { issuer: idp.issuer, clientId: idp.clientId }, adminGroups: ["platform"] });
    const v = new OidcVerifier(config);
    expect(await v.verify(await idp.sign())).toEqual({ sub: "okta|1", email: "alice@acme.com", name: "Alice", groups: ["engineering", "platform"], admin: true });
    await expect(v.verify(await idp.sign({}, { aud: "someone-else" }))).rejects.toThrow();
    await expect(v.verify(await idp.sign({}, { iss: "https://evil.example" }))).rejects.toThrow();
    await expect(v.verify(await idp.sign({}, { exp: "-1m" }))).rejects.toThrow();
  });

  it("rejects unverified emails and missing claims", () => {
    expect(() => identityFromClaims({ sub: "x", email: "a@b.c", email_verified: false }, "groups", { admins: [], adminGroups: [] })).toThrow(/not verified/);
    expect(() => identityFromClaims({ sub: "x" }, "groups", { admins: [], adminGroups: [] })).toThrow(/no email/);
  });
});
