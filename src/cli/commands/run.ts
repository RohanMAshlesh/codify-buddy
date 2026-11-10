import readline from "node:readline";
import type { PermissionMode } from "../../config/config.js";
import { Engine } from "../../engine/engine.js";
import type { EngineEvent } from "../../engine/events.js";
import { terminalPrompter } from "../prompt.js";
import { TerminalRenderer } from "../render.js";

export interface RunOptions {
  prompt: string;
  json?: boolean;
  mode?: PermissionMode;
  model?: string;
  effort?: string;
  resume?: string;
  showThinking?: boolean;
}

/** One-shot run: send a single prompt, stream the result, exit. */
export async function runOnce(opts: RunOptions): Promise<number> {
  const interactive = !opts.json && process.stdin.isTTY && process.stdout.isTTY;
  // Non-interactive runs default to read-only so CI never changes files by surprise.
  const mode: PermissionMode | undefined = opts.mode ?? (interactive ? undefined : "read-only");
  let rl: readline.Interface | null = null;
  const getRl = () => (rl ??= readline.createInterface({ input: process.stdin, output: process.stdout }));

  const engine = Engine.create({
    overrides: {
      ...(mode ? { permissionMode: mode } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort as never } : {}),
    },
    prompter: interactive ? terminalPrompter(getRl) : undefined,
    resume: opts.resume,
  });

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  const sink = opts.json
    ? (ev: EngineEvent) => process.stdout.write(JSON.stringify(ev) + "\n")
    : new TerminalRenderer({ showThinking: opts.showThinking }).handle;
  try {
    const res = await engine.send(opts.prompt, sink, controller.signal);
    if (opts.json) process.stdout.write(JSON.stringify({ type: "result", sessionId: engine.session.id, ...res }) + "\n");
    return res.stopReason === "error" ? 1 : res.stopReason === "refusal" ? 2 : 0;
  } finally {
    process.off("SIGINT", onSigint);
    (rl as readline.Interface | null)?.close();
  }
}
