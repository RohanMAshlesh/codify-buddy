import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveInRoot } from "../util/paths.js";
import { truncateMiddle } from "../util/tokens.js";
import { ToolError, type Tool, type ToolContext } from "./types.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function exec(command: string, args: string[], opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; shell?: boolean }): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, shell: opts.shell ?? false, env: process.env, signal: opts.signal });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = 2_000_000;
    child.stdout.on("data", (d: Buffer) => (stdout.length < cap ? (stdout += d.toString()) : undefined));
    child.stderr.on("data", (d: Buffer) => (stderr.length < cap ? (stderr += d.toString()) : undefined));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, opts.timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      if ((err as NodeJS.ErrnoException).code === "ABORT_ERR") resolve({ code: null, stdout, stderr: stderr + "\n[aborted]", timedOut });
      else reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function formatExec(r: ExecResult): string {
  const parts = [];
  if (r.stdout.trim()) parts.push(`<stdout>\n${truncateMiddle(r.stdout.trimEnd(), 10_000)}\n</stdout>`);
  if (r.stderr.trim()) parts.push(`<stderr>\n${truncateMiddle(r.stderr.trimEnd(), 5_000)}\n</stderr>`);
  parts.push(r.timedOut ? "exit: timed out" : `exit: ${r.code}`);
  return parts.join("\n");
}

export const runCommandTool: Tool<{ command: string; cwd?: string; timeout_ms?: number }> = {
  name: "run_command",
  description:
    "Run a shell command in the project (e.g. tests, builds, linters). Output is captured; interactive commands are not supported. Default timeout 120s.",
  access: "exec",
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional().describe("Working directory relative to project root"),
    timeout_ms: z.number().int().positive().max(600_000).optional(),
  }),
  describe: (i) => `$ ${i.command}${i.cwd ? `  (in ${i.cwd})` : ""}`,
  async run(input, ctx: ToolContext) {
    const cwd = resolveInRoot(ctx.root, input.cwd ?? ".");
    const r = await exec(input.command, [], { cwd, timeoutMs: input.timeout_ms ?? 120_000, signal: ctx.signal, shell: true });
    return {
      content: formatExec(r),
      isError: r.code !== 0,
      summary: `$ ${input.command} → ${r.timedOut ? "timeout" : `exit ${r.code}`}`,
    };
  },
};

const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "blame", "branch", "ls-files", "rev-parse", "shortlog"]);

export const gitTool: Tool<{ args: string[] }> = {
  name: "git",
  description: `Run a read-only git command. Allowed subcommands: ${[...READ_ONLY_GIT].join(", ")}. Example: {"args": ["diff", "--stat"]}`,
  access: "read",
  schema: z.object({ args: z.array(z.string()).min(1) }),
  describe: (i) => `git ${i.args.join(" ")}`,
  async run(input, ctx) {
    const sub = input.args[0]!;
    if (!READ_ONLY_GIT.has(sub)) throw new ToolError(`git ${sub} is not allowed here; use run_command for state-changing git commands`);
    if (input.args.some((a) => a.startsWith("--output") || a === "-o" || a.startsWith("--exec"))) {
      throw new ToolError("That git option is not allowed in read-only mode");
    }
    const r = await exec("git", ["--no-pager", ...input.args], { cwd: ctx.root, timeoutMs: 30_000, signal: ctx.signal });
    return { content: formatExec(r), isError: r.code !== 0, summary: `git ${input.args.join(" ")}` };
  },
};
