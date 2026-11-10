import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { ContextIndex } from "../src/context/index.js";
import { PermissionGate } from "../src/tools/permissions.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";
import { lineDiff } from "../src/util/diff.js";
import { makeTempDir } from "./helpers.js";

function setup(files: Record<string, string>) {
  const root = makeTempDir(files);
  process.env.CODIFY_HOME = makeTempDir();
  const config = loadConfig(root, {}, {});
  const index = new ContextIndex(root, config.context);
  index.update();
  const ctx: ToolContext = { root, config, index };
  const reg = new ToolRegistry();
  const run = (name: string, input: unknown) => reg.get(name)!.run(reg.get(name)!.schema.parse(input), ctx);
  return { root, ctx, reg, run };
}

describe("registry", () => {
  it("emits stable JSON-schema tool definitions", () => {
    const defs = new ToolRegistry().definitions();
    expect(defs.map((d) => d.name)).toEqual([
      "search_context", "find_files", "read_file", "list_dir", "grep", "git", "edit_file", "write_file", "run_command",
    ]);
    const edit = defs.find((d) => d.name === "edit_file")!;
    expect(edit.input_schema.type).toBe("object");
    expect(edit.input_schema.required).toEqual(["path", "old_string", "new_string"]);
    expect(JSON.stringify(new ToolRegistry().definitions())).toBe(JSON.stringify(defs));
  });
});

describe("fs tools", () => {
  it("reads numbered lines with ranges", async () => {
    const { run } = setup({ "a.txt": "one\ntwo\nthree\n" });
    const out = await run("read_file", { path: "a.txt", start_line: 2, end_line: 3 });
    expect(out.content).toBe("2\ttwo\n3\tthree");
  });

  it("refuses paths outside the root", async () => {
    const { run } = setup({});
    await expect(run("read_file", { path: "../../etc/passwd" })).rejects.toThrow(/escapes/);
  });

  it("edits unique strings and reports diffs", async () => {
    const { root, run } = setup({ "a.ts": "const a = 1;\nconst b = 1;\n" });
    await expect(run("edit_file", { path: "a.ts", old_string: "= 1", new_string: "= 2" })).rejects.toThrow(/occurs 2 times/);
    const out = await run("edit_file", { path: "a.ts", old_string: "const b = 1", new_string: "const b = 2" });
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toBe("const a = 1;\nconst b = 2;\n");
    expect(out.diff).toContain("-const b = 1;");
    expect(out.diff).toContain("+const b = 2;");
  });

  it("writes new files creating directories", async () => {
    const { root, run } = setup({});
    await run("write_file", { path: "deep/new.ts", content: "x" });
    expect(fs.readFileSync(path.join(root, "deep/new.ts"), "utf8")).toBe("x");
  });

  it("greps and lists", async () => {
    const { run } = setup({ "src/a.ts": "export const token = 1;\n", "src/b.ts": "nothing\n" });
    expect((await run("grep", { pattern: "token" })).content).toBe("src/a.ts:1: export const token = 1;");
    expect((await run("list_dir", {})).content).toBe("src/\nsrc/a.ts\nsrc/b.ts");
  });

  it("search_context returns cited snippets", async () => {
    const { run } = setup({ "src/pay.ts": "export function issueRefund(id: string) {\n  return id;\n}\n" });
    const out = await run("search_context", { query: "issue refund" });
    expect(out.content).toContain('citation="src/pay.ts:1-3"');
  });
});

describe("shell tools", () => {
  it("runs commands and captures exit codes", async () => {
    const { run } = setup({});
    const ok = await run("run_command", { command: "echo hello" });
    expect(ok.content).toContain("hello");
    expect(ok.isError).toBe(false);
    const bad = await run("run_command", { command: "exit 3" });
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain("exit: 3");
  });

  it("only allows read-only git subcommands", async () => {
    const { run } = setup({});
    await expect(run("git", { args: ["push"] })).rejects.toThrow(/not allowed/);
  });
});

describe("PermissionGate", () => {
  const reg = new ToolRegistry();
  const req = { tool: "x", access: "write" as const, description: "d" };
  it("allows reads, denies everything else in read-only", async () => {
    const gate = new PermissionGate("read-only");
    expect((await gate.check(reg.get("read_file")!, req)).decision).toBe("allow");
    expect((await gate.check(reg.get("edit_file")!, req)).decision).toBe("deny");
  });
  it("auto-edit allows writes but asks for exec", async () => {
    const asked: string[] = [];
    const gate = new PermissionGate("auto-edit", async (r) => (asked.push(r.tool), "deny"));
    expect((await gate.check(reg.get("edit_file")!, req)).decision).toBe("allow");
    expect((await gate.check(reg.get("run_command")!, { ...req, tool: "run_command" })).decision).toBe("deny");
    expect(asked).toEqual(["run_command"]);
  });
  it("remembers allow_always per tool", async () => {
    let n = 0;
    const gate = new PermissionGate("ask", async () => (n++, "allow_always"));
    await gate.check(reg.get("edit_file")!, req);
    await gate.check(reg.get("edit_file")!, req);
    expect(n).toBe(1);
  });
  it("denies when no prompter is available", async () => {
    expect((await new PermissionGate("ask").check(reg.get("write_file")!, req)).decision).toBe("deny");
  });
});

describe("lineDiff", () => {
  it("produces hunks", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc", 1)).toBe("@@ -1 +1 @@\n a\n-b\n+B\n c");
    expect(lineDiff("same", "same")).toBe("");
  });
});

describe("connected documents", () => {
  it("search_context and read_file work with @source URIs", async () => {
    const { ctx, run } = setup({ "a.ts": "export const x = 1;\n" });
    ctx.index.setExternalSource({ id: "wiki", kind: "docs", label: "Team wiki", docs: [{ id: "p", title: "Deploy Guide", url: "https://wiki/p", text: "# Deploy Guide\n\nRun the blue-green deploy script.\n" }] });
    const found = await run("search_context", { query: "blue green deploy", scope: "docs" });
    expect(found.content).toContain('source="wiki"');
    expect(found.content).toContain('url="https://wiki/p"');
    const read = await run("read_file", { path: "@wiki/deploy-guide" });
    expect(read.content).toContain("url: https://wiki/p");
    expect(read.content).toContain("3\tRun the blue-green deploy script.");
    await expect(run("read_file", { path: "@wiki/missing" })).rejects.toThrow(/No connected document/);
  });
});
