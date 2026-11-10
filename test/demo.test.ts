import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { ConnectorManager } from "../src/connectors/manager.js";
import { ContextIndex, indexOptionsFor } from "../src/context/index.js";
import { createDemoProject, DEMO_FILES, lineOf } from "../src/demo/project.js";
import { DEMO_PROMPT, demoScript, ReplayTransport } from "../src/demo/replay.js";
import { Engine } from "../src/engine/engine.js";
import type { EngineEvent } from "../src/engine/events.js";
import { highlights } from "../src/tools/shell-tools.js";
import { makeTempDir } from "./helpers.js";

async function setupDemo() {
  process.env.CODIFY_HOME = makeTempDir();
  const dir = path.join(makeTempDir(), "codify-demo");
  createDemoProject(dir);
  const config = loadConfig(dir);
  const index = new ContextIndex(dir, indexOptionsFor(dir, config));
  index.update();
  const m = new ConnectorManager(config.connectors, { root: dir });
  for (const c of m.connectors) await m.sync(index, c.id);
  return { dir, index };
}

describe("demo project", () => {
  it("refuses to overwrite a non-empty folder without force", () => {
    const dir = makeTempDir({ "keep.txt": "mine" });
    expect(() => createDemoProject(dir)).toThrow(/not empty/);
  });

  it("surfaces both the policy and the code for the opening search", async () => {
    const { index } = await setupDemo();
    const hits = index.search("partial refund rounding cents", { limit: 8 }).hits.map((h) => h.path);
    expect(hits).toContain("@confluence/refund-policy");
    expect(hits).toContain("src/refunds.js");
    expect(hits.some((p) => p.startsWith("@github/42"))).toBe(true);
  });

  it("replays the session with real tool execution: red tests, fix, green tests", async () => {
    const { dir } = await setupDemo();
    const events: EngineEvent[] = [];
    const engine = await Engine.open({
      cwd: dir,
      transport: new ReplayTransport(demoScript({ canRunTests: true }), 0),
      persist: false,
      overrides: { permissionMode: "yolo", fallbacks: false },
    });
    const res = await engine.send(DEMO_PROMPT, (e) => events.push(e));
    expect(res.stopReason).toBe("end_turn");

    const results = events.filter((e): e is Extract<EngineEvent, { type: "tool_result" }> => e.type === "tool_result");
    expect(results.map((r) => [r.name, r.ok])).toEqual([
      ["search_context", true],
      ["read_file", true],
      ["read_file", true],
      ["run_command", false],
      ["edit_file", true],
      ["run_command", true],
    ]);
    expect(results[3]!.display).toContain("not ok 3 - partial refunds round half up");
    expect(fs.readFileSync(path.join(dir, "src/refunds.js"), "utf8")).toContain("Math.round((returnedValue / subtotal) * paid)");
    expect(execFileSync("git", ["diff", "--stat"], { cwd: dir, encoding: "utf8" })).toContain("src/refunds.js");

    // Citations in the recorded summary point at the right lines.
    const code = DEMO_FILES["src/refunds.js"]!.split("\n");
    expect(code[lineOf(DEMO_FILES["src/refunds.js"]!, "Math.floor(") - 1]).toContain("Math.floor((returnedValue");
    expect(res.text).toContain(`src/refunds.js:${lineOf(DEMO_FILES["src/refunds.js"]!, "Math.floor(")}`);
    expect(res.text).toContain("@confluence/refund-policy:");
    await engine.close();
  }, 30_000);

  it("skips test steps when npm is unavailable", () => {
    const tools = demoScript({ canRunTests: false }).map((s) => s.tool?.name).filter(Boolean);
    expect(tools).toEqual(["search_context", "read_file", "read_file", "edit_file"]);
  });
});

describe("highlights", () => {
  it("shows failures and summaries, not stack noise", () => {
    const out = "TAP version 13\n# Subtest: a\nok 1 - a\nnot ok 2 - b\n  error: |-\n  expected: 2\n  actual: 1\n    at Test.run (node:internal/test_runner/test:1:1)\n# tests 2\n# pass 1\n# fail 1\n";
    expect(highlights(out)).toBe("not ok 2 - b\nexpected: 2\nactual: 1\n# tests 2\n# pass 1\n# fail 1");
    expect(highlights("Tests:  3 passed, 3 total\n")).toBe("Tests:  3 passed, 3 total");
    expect(highlights("built ok\ndone\n")).toBe("built ok\ndone");
  });
});
