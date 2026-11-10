import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ContextIndex } from "../../src/context/index.js";
import { Controller, MemoryDocuments } from "../src/controller.js";
import type { ToWebview } from "../src/protocol.js";
import * as vscode from "./mocks/vscode.js";

// ---- a local stand-in for the Anthropic Messages streaming API ----
type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
const script: Block[][] = [];
let server: http.Server;
let baseUrl = "";

function sse(res: http.ServerResponse, blocks: Block[]) {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
  const events: object[] = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage } }];
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    events.push({ type: "content_block_stop", index });
  });
  const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
  events.push({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 5 } }, { type: "message_stop" });
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => sse(res, script.shift() ?? [{ type: "text", text: "(script exhausted)" }]));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

// ---- harness ----
function makeProject(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codify-ctl-")));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/refund.ts"), "export function refundAmount(c: number) {\n  return Math.floor(c / 2);\n}\n");
  return dir;
}

function harness(opts: { key?: string } = {}) {
  const root = makeProject();
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root) }];
  const posts: ToWebview[] = [];
  const view = { post: (m: ToWebview) => posts.push(m), reveal: async () => undefined } as never;
  const secrets = new Map<string, string>(opts.key ? [["codify.anthropicApiKey", opts.key]] : []);
  const context = {
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: { get: async (k: string) => secrets.get(k), store: async (k: string, v: string) => void secrets.set(k, v) },
  } as never;
  const status = { text: "", tooltip: "", command: "", show() {} } as never;
  const output = { appendLine: () => undefined } as never;
  const docs = new MemoryDocuments();
  vscode.workspace.registerTextDocumentContentProvider("codify-doc", docs);
  vscode.workspace.registerTextDocumentContentProvider("codify-proposed", docs);
  const controller = new Controller(context, view, docs, status, output);
  const waitFor = async (pred: (m: ToWebview) => boolean, ms = 15_000) => {
    const t0 = Date.now();
    for (;;) {
      const hit = posts.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error(`timed out; posts: ${JSON.stringify(posts.map((p) => p.type))}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { root, posts, controller, docs, status, waitFor };
}

beforeEach(() => {
  vscode.calls.length = 0;
  process.env.CODIFY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codify-home-"));
  process.env.ANTHROPIC_BASE_URL = baseUrl;
  process.env.NO_PROXY = "127.0.0.1";
  process.env.no_proxy = "127.0.0.1";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
});

describe("Controller", () => {
  it("asks for an API key when none is configured", async () => {
    const h = harness();
    await h.controller.ensureStarted();
    expect(h.posts.some((p) => p.type === "state" && p.status === "needsKey")).toBe(true);
    expect((h.status as unknown as { command: string }).command).toBe("codify.setApiKey");
    h.controller.dispose();
  }, 20_000);

  it("runs a turn: streams, asks approval with a native diff, applies the edit", async () => {
    const h = harness({ key: "sk-ant-test-0000" });
    script.push(
      [
        { type: "text", text: "Rounding is wrong. " },
        { type: "tool_use", id: "t1", name: "edit_file", input: { path: "src/refund.ts", old_string: "Math.floor(c / 2)", new_string: "Math.round(c / 2)" } },
      ],
      [{ type: "text", text: "Fixed in `src/refund.ts:2`." }],
    );
    await h.controller.ensureStarted();
    const ready = await h.waitFor((p) => p.type === "state" && p.status === "ready");
    expect(ready).toMatchObject({ info: { files: 1, mode: "ask" } });

    const sending = h.controller.send("fix the rounding");
    const perm = (await h.waitFor((p) => p.type === "permission")) as Extract<ToWebview, { type: "permission" }>;
    expect(perm).toMatchObject({ access: "write", tool: "edit_file", description: "edit src/refund.ts", hasChange: true });
    expect(perm.preview).toContain("+  return Math.round(c / 2);");

    // The diff editor opened on snapshot (before) vs proposed (after) virtual documents.
    const diff = vscode.calls.find((c) => c.fn === "executeCommand" && c.args[0] === "vscode.diff")!;
    expect(diff.args.slice(1, 4)).toEqual([
      `codify-proposed:/${perm.id}/before/src/refund.ts`,
      `codify-proposed:/${perm.id}/src/refund.ts`,
      "src/refund.ts (proposed by Codify)",
    ]);
    expect(h.docs.provideTextDocumentContent(vscode.Uri.parse(`codify-proposed:/${perm.id}/src/refund.ts`) as never)).toContain("Math.round(c / 2)");
    expect(fs.readFileSync(path.join(h.root, "src/refund.ts"), "utf8")).toContain("Math.floor");

    h.controller.answer(perm.id, "allow");
    await sending;
    expect(fs.readFileSync(path.join(h.root, "src/refund.ts"), "utf8")).toContain("Math.round(c / 2)");
    expect(h.posts).toContainEqual({ type: "permissionDone", id: perm.id, answer: "allow" });
    const texts = h.posts.flatMap((p) => (p.type === "event" && p.event.type === "text" ? [p.event.text] : [])).join("");
    expect(texts).toBe("Rounding is wrong. Fixed in `src/refund.ts:2`.");
    expect(h.posts.filter((p) => p.type === "busy").map((p) => (p as { busy: boolean }).busy)).toEqual([true, false]);
    expect(h.posts.find((p) => p.type === "user")).toEqual({ type: "user", text: "fix the rounding", context: undefined });
    h.controller.dispose();
  }, 30_000);

  it("denies pending approvals when the user stops", async () => {
    const h = harness({ key: "sk-ant-test-0000" });
    script.push([{ type: "tool_use", id: "t1", name: "run_command", input: { command: "echo hi" } }], [{ type: "text", text: "ok" }]);
    await h.controller.ensureStarted();
    const sending = h.controller.send("run it");
    const perm = (await h.waitFor((p) => p.type === "permission")) as Extract<ToWebview, { type: "permission" }>;
    expect(perm.hasChange).toBe(false);
    await h.controller.stop();
    await sending;
    expect(h.posts).toContainEqual({ type: "permissionDone", id: perm.id, answer: "deny" });
    h.controller.dispose();
  }, 30_000);

  it("opens citations: files at a line range, connected documents as virtual docs", async () => {
    const h = harness({ key: "sk-ant-test-0000" });
    const index = new ContextIndex(h.root, { maxFileBytes: 1_000_000 });
    index.setExternalSource({ id: "confluence", kind: "docs", label: "Confluence PAY", docs: [{ id: "1", title: "Refund Policy", url: "https://wiki.acme.com/1", text: "# Refund Policy\n\nRound half up.\n" }] });
    await h.controller.ensureStarted();

    await h.controller.openCitation("src/refund.ts:2");
    const shown = vscode.calls.filter((c) => c.fn === "showTextDocument").at(-1)!;
    expect(shown.args[0]).toBe(`file:${h.root}/src/refund.ts`);
    expect((shown.args[1] as { selection: vscode.Range }).selection).toEqual(new vscode.Range(1, 0, 1, "  return Math.floor(c / 2);".length));

    vscode.answers.info = "Open in browser";
    await h.controller.openCitation("@confluence/refund-policy:3");
    const docShown = vscode.calls.filter((c) => c.fn === "showTextDocument").at(-1)!;
    expect(docShown.args[0]).toBe("codify-doc:/confluence/refund-policy.md");
    // One header line is added above the document, so line 3 is shown as line index 3.
    expect((docShown.args[1] as { selection: vscode.Range }).selection.startLine).toBe(3);
    expect(h.docs.provideTextDocumentContent(vscode.Uri.parse("codify-doc:/confluence/refund-policy.md") as never)).toContain("Round half up.");
    expect(vscode.calls.some((c) => c.fn === "openExternal" && c.args[0] === "https:" + "//wiki.acme.com/1")).toBe(true);
    vscode.answers.info = undefined;

    await h.controller.openCitation("src/missing.ts:1");
    expect(vscode.calls.some((c) => c.fn === "showWarningMessage")).toBe(true);
    h.controller.dispose();
  }, 30_000);

  it("changes the permission mode from the quick pick", async () => {
    const h = harness({ key: "sk-ant-test-0000" });
    await h.controller.ensureStarted();
    vscode.answers.quickPick = (items) => items.find((i: { label: string }) => i.label === "read-only");
    await h.controller.pickMode();
    vscode.answers.quickPick = undefined;
    expect(h.posts.filter((p) => p.type === "state").at(-1)).toMatchObject({ info: { mode: "read-only" } });
    expect((h.status as unknown as { text: string }).text).toBe("$(code) Codify: read-only");
    h.controller.dispose();
  }, 20_000);
});
