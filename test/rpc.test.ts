import { PassThrough } from "node:stream";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import type { ModelTransport } from "../src/model/transport.js";
import { RpcServer } from "../src/rpc/server.js";
import { makeTempDir } from "./helpers.js";

function reply(content: unknown[], stop: string) {
  return {
    id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_details: null,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Beta.BetaMessage;
}

function harness(script: Anthropic.Beta.BetaMessage[]) {
  process.env.CODIFY_HOME = makeTempDir();
  const root = makeTempDir({ ".git/HEAD": "x", "src/a.ts": "export function alpha() {\n  return 1;\n}\n" });
  const transport: ModelTransport = { stream: async () => script.shift()! };
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new RpcServer(input, output, (opts) => Engine.create({ ...opts, transport }));
  const received: any[] = [];
  let buf = "";
  const waiters: Array<{ pred: (m: any) => boolean; resolve: (m: any) => void }> = [];
  output.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      received.push(msg);
      for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
    }
  });
  const waitFor = (pred: (m: any) => boolean) =>
    new Promise<any>((resolve) => {
      const hit = received.find(pred);
      if (hit) resolve(hit);
      else waiters.push({ pred, resolve });
    });
  const send = (msg: object) => input.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
  return { root, server, input, received, waitFor, send };
}

describe("RpcServer", () => {
  it("initializes, searches and rejects unknown methods", async () => {
    const h = harness([]);
    h.send({ id: 1, method: "context/search", params: { query: "alpha" } });
    expect((await h.waitFor((m) => m.id === 1)).error.code).toBe(-32002);
    h.send({ id: 2, method: "initialize", params: { cwd: h.root } });
    expect((await h.waitFor((m) => m.id === 2)).result).toMatchObject({ root: h.root, files: 1, model: "claude-opus-5-5" });
    h.send({ id: 3, method: "context/search", params: { query: "alpha" } });
    expect((await h.waitFor((m) => m.id === 3)).result.hits[0].citation).toBe("src/a.ts:1-3");
    h.send({ id: 4, method: "nope" });
    expect((await h.waitFor((m) => m.id === 4)).error.code).toBe(-32601);
    h.input.write("not json\n");
    expect((await h.waitFor((m) => m.error?.code === -32700)).id).toBeNull();
  });

  it("streams chat events and round-trips permission requests", async () => {
    const h = harness([
      reply([{ type: "tool_use", id: "t1", name: "write_file", input: { path: "b.ts", content: "x" } }], "tool_use"),
      reply([{ type: "text", text: "done" }], "end_turn"),
    ]);
    h.send({ id: 1, method: "initialize", params: { cwd: h.root } });
    await h.waitFor((m) => m.id === 1);
    h.send({ id: 2, method: "chat/send", params: { text: "make b" } });
    const perm = await h.waitFor((m) => m.method === "permission/request");
    expect(perm.params).toMatchObject({ tool: "write_file", access: "write" });
    h.send({ id: perm.id, result: { answer: "allow" } });
    const res = await h.waitFor((m) => m.id === 2);
    expect(res.result).toMatchObject({ text: "done", stopReason: "end_turn" });
    const kinds = h.received.filter((m) => m.method === "chat/event").map((m) => m.params.event.type);
    expect(kinds).toEqual(expect.arrayContaining(["turn_start", "tool_call", "tool_result", "usage", "turn_end"]));
  });
});

describe("RpcServer IDE methods", () => {
  it("changes settings, reads files and documents, lists sources", async () => {
    const h = harness([]);
    h.send({ id: 1, method: "initialize", params: { cwd: h.root } });
    const init = (await h.waitFor((m) => m.id === 1)).result;
    expect(init).toMatchObject({ mode: "ask", effort: "medium", sources: [], mcp: [] });
    expect(typeof init.version).toBe("string");

    h.send({ id: 2, method: "chat/setMode", params: { mode: "auto-edit" } });
    expect((await h.waitFor((m) => m.id === 2)).result).toEqual({ mode: "auto-edit" });
    h.send({ id: 3, method: "chat/setMode", params: { mode: "nope" } });
    expect((await h.waitFor((m) => m.id === 3)).error.code).toBe(-32602);
    h.send({ id: 4, method: "chat/setEffort", params: { effort: "high" } });
    expect((await h.waitFor((m) => m.id === 4)).result).toEqual({ effort: "high" });

    h.send({ id: 5, method: "context/read", params: { path: "src/a.ts", start_line: 2, end_line: 2 } });
    expect((await h.waitFor((m) => m.id === 5)).result.content).toMatch(/^2\t  return 1;\n/);
    h.send({ id: 6, method: "context/read", params: { path: "../outside" } });
    expect((await h.waitFor((m) => m.id === 6)).error.message).toMatch(/escapes/);

    h.send({ id: 7, method: "sources/list" });
    expect((await h.waitFor((m) => m.id === 7)).result).toEqual([]);
    h.send({ id: 8, method: "sessions/resume", params: { id: "missing" } });
    expect((await h.waitFor((m) => m.id === 8)).error.message).toMatch(/not found/);
  });

  it("sends full before/after contents with write approvals", async () => {
    const h = harness([
      reply([{ type: "tool_use", id: "t1", name: "edit_file", input: { path: "src/a.ts", old_string: "return 1", new_string: "return 2" } }], "tool_use"),
      reply([{ type: "text", text: "ok" }], "end_turn"),
    ]);
    h.send({ id: 1, method: "initialize", params: { cwd: h.root } });
    await h.waitFor((m) => m.id === 1);
    h.send({ id: 2, method: "chat/send", params: { text: "bump" } });
    const perm = await h.waitFor((m) => m.method === "permission/request");
    expect(perm.params.change).toEqual({
      path: "src/a.ts",
      before: "export function alpha() {\n  return 1;\n}\n",
      after: "export function alpha() {\n  return 2;\n}\n",
      isNew: false,
    });
    h.send({ id: perm.id, result: { answer: "deny" } });
    expect((await h.waitFor((m) => m.id === 2)).result.stopReason).toBe("end_turn");
  });

  it("reports missing credentials with a dedicated error code", async () => {
    const { MissingCredentialsError } = await import("../src/model/client.js");
    const input = new PassThrough();
    const output = new PassThrough();
    new RpcServer(input, output, () => {
      throw new MissingCredentialsError();
    });
    const got = new Promise<any>((resolve) => output.once("data", (d: Buffer) => resolve(JSON.parse(d.toString()))));
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    expect((await got).error.code).toBe(-32001);
  });
});

describe("transcriptOf", () => {
  it("keeps user prompts and assistant text, drops tool traffic", async () => {
    const { transcriptOf } = await import("../src/rpc/server.js");
    expect(
      transcriptOf([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Looking." }, { type: "tool_use" }] },
        { role: "user", content: [{ type: "tool_result" }] },
        { role: "assistant", content: [{ type: "text", text: "Done." }] },
      ]),
    ).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "Looking." },
      { role: "assistant", text: "Done." },
    ]);
  });
});
