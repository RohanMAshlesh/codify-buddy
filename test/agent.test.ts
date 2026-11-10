import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine.js";
import type { EngineEvent } from "../src/engine/events.js";
import { listSessions } from "../src/engine/session.js";
import type { ModelTransport, StreamParams } from "../src/model/transport.js";
import { makeTempDir } from "./helpers.js";

type Block = Record<string, unknown>;

function msg(content: Block[], stop: string, extra: Record<string, unknown> = {}): Anthropic.Beta.BetaMessage {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_details: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
    ...extra,
  } as unknown as Anthropic.Beta.BetaMessage;
}

/** Scripted transport: returns queued responses and records requests. */
class FakeTransport implements ModelTransport {
  requests: StreamParams[] = [];
  constructor(private script: Array<Anthropic.Beta.BetaMessage | Error>) {}
  async stream(params: StreamParams, handlers: { onText?(t: string): void }) {
    this.requests.push(structuredClone(params));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    if (next instanceof Error) throw next;
    for (const b of next.content) if (b.type === "text") handlers.onText?.(b.text);
    return next;
  }
}

const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });
const text = (t: string): Block => ({ type: "text", text: t });

let root: string;
beforeEach(() => {
  process.env.CODIFY_HOME = makeTempDir();
  root = makeTempDir({
    ".git/HEAD": "ref: refs/heads/main",
    "src/math.ts": "export function add(a: number, b: number) {\n  return a - b;\n}\n",
    "CODIFY.md": "Always use tabs.",
  });
});

function engine(script: Array<Anthropic.Beta.BetaMessage | Error>, opts: Partial<Parameters<typeof Engine.create>[0]> = {}) {
  const transport = new FakeTransport(script);
  const e = Engine.create({ cwd: root, transport, ...opts });
  const events: EngineEvent[] = [];
  return { e, transport, events, sink: (ev: EngineEvent) => events.push(ev) };
}

describe("agent loop", () => {
  it("answers directly and builds a cache-friendly request", async () => {
    const { e, transport, events, sink } = engine([msg([text("Hello!")], "end_turn")]);
    const res = await e.send("hi", sink);
    expect(res).toMatchObject({ text: "Hello!", stopReason: "end_turn" });
    const req = transport.requests[0]!;
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(req.cache_control).toEqual({ type: "ephemeral" });
    expect(req.fallbacks).toBe("default");
    const sys = req.system as Array<{ text: string; cache_control?: unknown }>;
    expect(sys[1]!.cache_control).toEqual({ type: "ephemeral" });
    expect(sys[1]!.text).toContain("src/math.ts: add");
    expect(sys[1]!.text).toContain("Always use tabs.");
    expect(events.map((x) => x.type)).toEqual(["turn_start", "text", "usage", "turn_end"]);
  });

  it("keeps the system prefix byte-identical across turns", async () => {
    const { e, transport, sink } = engine([msg([text("a")], "end_turn"), msg([text("b")], "end_turn")]);
    await e.send("one", sink);
    fs.writeFileSync(path.join(root, "src/new.ts"), "export const x = 1;\n");
    await e.send("two", sink);
    expect(JSON.stringify(transport.requests[1]!.system)).toBe(JSON.stringify(transport.requests[0]!.system));
    expect(JSON.stringify(transport.requests[1]!.tools)).toBe(JSON.stringify(transport.requests[0]!.tools));
    expect(transport.requests[1]!.messages).toHaveLength(3);
  });

  it("runs tools, gates writes, and feeds results back", async () => {
    const prompts: string[] = [];
    const { e, transport, events, sink } = engine(
      [
        msg([text("Let me look."), toolUse("t1", "read_file", { path: "src/math.ts" })], "tool_use"),
        msg([toolUse("t2", "edit_file", { path: "src/math.ts", old_string: "a - b", new_string: "a + b" })], "tool_use"),
        msg([text("Fixed the bug in src/math.ts:2.")], "end_turn"),
      ],
      { prompter: async (r) => (prompts.push(r.description + "|" + (r.preview ?? "")), "allow") },
    );
    const res = await e.send("fix add", sink);
    expect(res.text).toBe("Fixed the bug in src/math.ts:2.");
    expect(fs.readFileSync(path.join(root, "src/math.ts"), "utf8")).toContain("return a + b;");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("edit src/math.ts|");
    expect(prompts[0]).toContain("+  return a + b;");

    const second = transport.requests[1]!.messages.at(-1)!;
    expect(second.role).toBe("user");
    const result = (second.content as Array<{ type: string; content: string; tool_use_id: string }>)[0]!;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "t1" });
    expect(result.content).toContain("2\t  return a - b;");
    const results = events.filter((x) => x.type === "tool_result");
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });

  it("returns permission denials and invalid input as tool errors", async () => {
    const { e, transport, sink } = engine(
      [
        msg([toolUse("t1", "run_command", { command: "rm -rf /" }), toolUse("t2", "read_file", { nope: 1 })], "tool_use"),
        msg([text("ok")], "end_turn"),
      ],
      { prompter: async () => "deny" },
    );
    await e.send("do it", sink);
    const results = transport.requests[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>;
    expect(results[0]).toMatchObject({ is_error: true });
    expect(results[0]!.content).toMatch(/Permission denied/);
    expect(results[1]!.content).toMatch(/Invalid input for read_file/);
  });

  it("drops a refused turn and reports it", async () => {
    const { e, events, sink } = engine([
      msg([], "refusal", { stop_details: { type: "refusal", category: null, explanation: "policy" } }),
    ]);
    const res = await e.send("bad", sink);
    expect(res.stopReason).toBe("refusal");
    expect(e.session.messages).toHaveLength(0);
    expect(events.some((x) => x.type === "notice" && x.message.includes("policy"))).toBe(true);
  });

  it("does not run tools whose input was cut off by max_tokens", async () => {
    const { e, transport, sink } = engine([
      msg([toolUse("t1", "write_file", { path: "x.ts" })], "max_tokens"),
      msg([text("retrying smaller")], "end_turn"),
    ], { overrides: { permissionMode: "yolo" } });
    await e.send("write", sink);
    expect(fs.existsSync(path.join(root, "x.ts"))).toBe(false);
    const res = transport.requests[1]!.messages.at(-1)!.content as Array<{ content: string }>;
    expect(res[0]!.content).toMatch(/truncated/);
  });

  it("rolls back the user message on API errors and persists sessions", async () => {
    const { e, events, sink } = engine([
      new Anthropic.APIConnectionError({ message: "down" }),
      msg([text("back")], "end_turn"),
    ]);
    const r1 = await e.send("first", sink);
    expect(r1.stopReason).toBe("error");
    expect(e.session.messages).toHaveLength(0);
    expect(events.some((x) => x.type === "notice" && x.level === "error")).toBe(true);
    await e.send("second", sink);
    const sessions = listSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.title).toBe("first");

    const resumed = Engine.create({ cwd: root, transport: new FakeTransport([]), resume: sessions[0]!.id });
    expect(resumed.session.messages).toHaveLength(2);
  });
});
