import readline from "node:readline";
import pc from "picocolors";
import type { PermissionAnswer, PermissionRequest } from "../tools/permissions.js";
import { colorDiff } from "./render.js";

const CTRL_C = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(127);

/** Ask a question on the terminal; resolves with the trimmed answer. */
export function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

/** Read a secret without echoing it (falls back to reading stdin when piped). */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      let data = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (d) => (data += d));
      stdin.on("end", () => resolve(data.trim()));
      return;
    }
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (c === CTRL_C) {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (c === BACKSPACE || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

/** Build a permission prompter that asks on the given readline interface. */
export function terminalPrompter(getRl: () => readline.Interface) {
  return async (req: PermissionRequest): Promise<PermissionAnswer> => {
    const rl = getRl();
    const label = req.access === "exec" ? "Run command" : "Change files";
    if (req.preview) process.stdout.write(colorDiff(req.preview, 60) + "\n");
    for (;;) {
      const a = (await ask(rl, pc.yellow(`? ${label}: ${req.description}  [y]es / [a]lways / [n]o › `))).toLowerCase();
      if (a === "y" || a === "yes" || a === "") return "allow";
      if (a === "a" || a === "always") return "allow_always";
      if (a === "n" || a === "no") return "deny";
    }
  };
}
