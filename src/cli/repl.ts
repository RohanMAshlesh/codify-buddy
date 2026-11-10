import readline from "node:readline";
import pc from "picocolors";
import { EFFORTS, PERMISSION_MODES, type Effort, type PermissionMode } from "../config/config.js";
import type { Engine } from "../engine/engine.js";
import { listSessions, loadSession } from "../engine/session.js";
import { estimateCost } from "../model/pricing.js";
import { printSearch } from "./commands/search.js";
import { formatUsage, TerminalRenderer } from "./render.js";

const HELP = `
${pc.bold("Commands")}
  /help                 show this help
  /new                  start a new conversation
  /sessions             list saved sessions for this project
  /resume <id>          resume a saved session
  /search <query>       search the project index (no model call)
  /index                refresh the project index
  /mode <mode>          permission mode: ${PERMISSION_MODES.join(" | ")}
  /effort <level>       thinking effort: ${EFFORTS.join(" | ")}
  /model <id>           switch model (e.g. claude-sonnet-5-5)
  /cost                 token usage and estimated cost for this session
  /exit                 quit

${pc.bold("Tips")}
  End a line with \\ to continue on the next line.
  Ctrl+C interrupts a running turn; press it again at the prompt to quit.
`;

export interface ReplOptions {
  showThinking?: boolean;
}

/** Interactive chat loop. Resolves when the user exits. */
export async function runRepl(engine: Engine, rl: readline.Interface, opts: ReplOptions = {}): Promise<void> {
  const renderer = new TerminalRenderer({ showThinking: opts.showThinking });
  let controller: AbortController | null = null;
  let lastSigint = 0;

  rl.on("SIGINT", () => {
    if (controller) {
      controller.abort();
      process.stdout.write(pc.yellow("\n! interrupting…\n"));
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 1500) {
      rl.close();
      return;
    }
    lastSigint = now;
    process.stdout.write(pc.dim("\n(press Ctrl+C again to exit, or type /exit)\n"));
    rl.prompt();
  });

  const readInput = (): Promise<string | null> =>
    new Promise((resolve) => {
      const lines: string[] = [];
      const onClose = () => resolve(null);
      rl.once("close", onClose);
      const next = (prefix: string) =>
        rl.question(prefix, (line) => {
          if (line.endsWith("\\")) {
            lines.push(line.slice(0, -1));
            next(pc.dim("… "));
            return;
          }
          lines.push(line);
          rl.off("close", onClose);
          resolve(lines.join("\n"));
        });
      next(pc.magenta("› "));
    });

  for (;;) {
    const input = await readInput();
    if (input === null) break;
    const text = input.trim();
    if (!text) continue;

    if (text.startsWith("/")) {
      const quit = await handleSlash(engine, text);
      if (quit) break;
      continue;
    }

    controller = new AbortController();
    try {
      await engine.send(text, renderer.handle, controller.signal);
    } finally {
      controller = null;
    }
  }
  rl.close();
}

/** Returns true when the REPL should exit. */
async function handleSlash(engine: Engine, line: string): Promise<boolean> {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const say = (s: string) => process.stdout.write(s + "\n");
  switch (cmd) {
    case "exit":
    case "quit":
      return true;
    case "help":
      say(HELP);
      break;
    case "new":
      engine.reset();
      say(pc.dim("Started a new conversation."));
      break;
    case "sessions": {
      const list = listSessions(engine.root).slice(0, 15);
      if (!list.length) say(pc.dim("No saved sessions yet."));
      for (const s of list) say(`${pc.cyan(s.id)}  ${pc.dim(s.updatedAt.slice(0, 16).replace("T", " "))}  ${s.title || pc.dim("(untitled)")}`);
      break;
    }
    case "resume": {
      const s = arg ? loadSession(engine.root, arg) : null;
      if (!s) say(pc.red(`Session not found: ${arg || "(missing id)"}`));
      else {
        engine.session = s;
        say(pc.dim(`Resumed ${s.id}: ${s.title}`));
      }
      break;
    }
    case "search":
      if (!arg) say(pc.red("Usage: /search <query>"));
      else printSearch(engine.index, arg, { limit: 8 });
      break;
    case "index": {
      const st = engine.index.update();
      say(pc.dim(`Indexed ${st.files} files (${st.added} added, ${st.changed} changed, ${st.removed} removed) in ${st.ms}ms.`));
      break;
    }
    case "mode":
      if (!PERMISSION_MODES.includes(arg as PermissionMode)) say(pc.red(`Mode must be one of: ${PERMISSION_MODES.join(", ")}`));
      else {
        engine.gate.mode = arg as PermissionMode;
        say(pc.dim(`Permission mode: ${arg}`));
      }
      break;
    case "effort":
      if (!EFFORTS.includes(arg as Effort)) say(pc.red(`Effort must be one of: ${EFFORTS.join(", ")}`));
      else {
        engine.config.effort = arg as Effort;
        say(pc.dim(`Effort: ${arg}`));
      }
      break;
    case "model":
      if (!arg) say(`Model: ${engine.config.model}`);
      else {
        engine.config.model = arg;
        say(pc.dim(`Model: ${arg} (prompt cache restarts for the new model)`));
      }
      break;
    case "cost": {
      const u = engine.session.usage;
      say(formatUsage(u, estimateCost(engine.config.model, u)));
      break;
    }
    default:
      say(pc.red(`Unknown command /${cmd}. Type /help.`));
  }
  return false;
}
