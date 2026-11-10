#!/usr/bin/env node
import readline from "node:readline";
import { Command, Option } from "commander";
import pc from "picocolors";
import pkg from "../../package.json" with { type: "json" };
import {
  EFFORTS,
  globalConfigFile,
  loadConfig,
  parseConfigValue,
  PERMISSION_MODES,
  projectConfigFile,
  setConfigValue,
  type PermissionMode,
} from "../config/config.js";
import { resolveCredentials } from "../config/credentials.js";
import { findProjectRoot } from "../config/paths.js";
import { ContextIndex } from "../context/index.js";
import { Engine } from "../engine/engine.js";
import { listSessions } from "../engine/session.js";
import { MissingCredentialsError } from "../model/client.js";
import { runDoctor } from "./commands/doctor.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runOnce } from "./commands/run.js";
import { printSearch } from "./commands/search.js";
import { terminalPrompter } from "./prompt.js";
import { runRepl } from "./repl.js";
import { banner } from "./render.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

interface MainOptions {
  print?: boolean;
  json?: boolean;
  mode?: PermissionMode;
  model?: string;
  effort?: string;
  resume?: string;
  continue?: boolean;
  thinking?: boolean;
}

async function ensureCredentials(interactive: boolean): Promise<boolean> {
  if (resolveCredentials().source !== "none") return true;
  if (!interactive) {
    process.stderr.write(pc.red("No API key found. Set ANTHROPIC_API_KEY or run `codify login`.\n"));
    return false;
  }
  process.stdout.write(pc.yellow("No API key found — let's set one up (one time only).\n"));
  return runLogin();
}

async function main(promptParts: string[], opts: MainOptions): Promise<number> {
  const resume = opts.continue ? listSessions(findProjectRoot())[0]?.id : opts.resume;
  if (opts.continue && !resume) process.stderr.write(pc.dim("No previous session to continue; starting fresh.\n"));

  const piped = await readStdin();
  let prompt = promptParts.join(" ").trim();
  if (piped.trim()) prompt = prompt ? `${prompt}\n\n<stdin>\n${piped.trim()}\n</stdin>` : piped.trim();

  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  if (!(await ensureCredentials(interactive && !opts.json))) return 1;

  if (prompt || opts.print || opts.json || !interactive) {
    if (!prompt) {
      process.stderr.write(pc.red("No prompt given. Usage: codify \"your question\"\n"));
      return 1;
    }
    return runOnce({ prompt, json: opts.json, mode: opts.mode, model: opts.model, effort: opts.effort, resume, showThinking: opts.thinking });
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 500 });
  const engine = Engine.create({
    overrides: {
      ...(opts.mode ? { permissionMode: opts.mode } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort as never } : {}),
    },
    prompter: terminalPrompter(() => rl),
    resume,
  });
  process.stdout.write(banner(engine.root, engine.index.fileCount, engine.config.model, engine.gate.mode) + "\n");
  if (resume) process.stdout.write(pc.dim(`  resumed session ${resume}: ${engine.session.title}\n`));
  process.stdout.write("\n");
  await runRepl(engine, rl, { showThinking: opts.thinking });
  return 0;
}

function build(): Command {
  const program = new Command();
  program
    .name("codify")
    .description("Codify Buddy — an AI coding copilot that knows your code, docs and tools.")
    .version(pkg.version, "-v, --version")
    .argument("[prompt...]", "ask a question or give a task; omit for interactive mode")
    .option("-p, --print", "run once and print the answer (non-interactive)")
    .option("--json", "run once and stream newline-delimited JSON events (for scripts and CI)")
    .addOption(new Option("--mode <mode>", "permission mode").choices([...PERMISSION_MODES]))
    .option("-m, --model <model>", "model id (default claude-opus-5-5)")
    .addOption(new Option("-e, --effort <level>", "thinking effort").choices([...EFFORTS]))
    .option("-r, --resume <id>", "resume a saved session")
    .option("-c, --continue", "continue the most recent session")
    .option("--thinking", "show the model's reasoning summary while it works")
    .action(async (parts: string[], opts: MainOptions) => {
      process.exitCode = await main(parts, opts);
    });

  program
    .command("login")
    .description("store your Anthropic API key in ~/.codify")
    .option("--no-verify", "skip checking the key against the API")
    .action(async (o: { verify: boolean }) => {
      process.exitCode = (await runLogin({ verify: o.verify })) ? 0 : 1;
    });

  program.command("logout").description("remove the stored API key").action(() => runLogout());

  program
    .command("doctor")
    .description("check runtime, credentials, API access, config and index")
    .option("--offline", "skip the API reachability check")
    .option("--json", "output checks as JSON")
    .action(async (o: { offline?: boolean; json?: boolean }) => {
      process.exitCode = await runDoctor(o);
    });

  program
    .command("index")
    .description("build or refresh the local project index")
    .option("--rebuild", "discard the existing index first")
    .action((o: { rebuild?: boolean }) => {
      const root = findProjectRoot();
      const idx = new ContextIndex(root, loadConfig(root).context);
      if (!o.rebuild) idx.load();
      const st = idx.update();
      process.stdout.write(
        `${pc.green("✔")} ${st.files} files · ${st.chunks} chunks · ${st.added} added, ${st.changed} changed, ${st.removed} removed · ${st.ms}ms\n` +
          pc.dim(`  ${idx.indexFile}\n`),
      );
    });

  program
    .command("search")
    .description("search the project index (works offline, no model call)")
    .argument("<query...>")
    .option("-n, --limit <n>", "max results", "10")
    .option("--path <filter>", "only paths containing this string")
    .option("--json", "output JSON")
    .action((query: string[], o: { limit: string; path?: string; json?: boolean }) => {
      const root = findProjectRoot();
      const idx = new ContextIndex(root, loadConfig(root).context);
      idx.load();
      idx.update();
      printSearch(idx, query.join(" "), { limit: Number(o.limit), pathFilter: o.path, json: o.json });
    });

  program
    .command("sessions")
    .description("list saved sessions for this project")
    .action(() => {
      const list = listSessions(findProjectRoot());
      if (!list.length) process.stdout.write(pc.dim("No saved sessions yet.\n"));
      for (const s of list) {
        process.stdout.write(`${pc.cyan(s.id)}  ${pc.dim(s.updatedAt.slice(0, 16).replace("T", " "))}  ${s.title || pc.dim("(untitled)")}\n`);
      }
    });

  const config = program.command("config").description("view or change settings");
  config
    .command("list")
    .description("show the effective configuration")
    .action(() => {
      process.stdout.write(JSON.stringify(loadConfig(findProjectRoot()), null, 2) + "\n");
    });
  config
    .command("get <key>")
    .description("show one setting, e.g. `codify config get context.budgetTokens`")
    .action((key: string) => {
      let v: unknown = loadConfig(findProjectRoot());
      for (const p of key.split(".")) v = (v as Record<string, unknown> | undefined)?.[p];
      process.stdout.write((v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)) + "\n");
    });
  config
    .command("set <key> <value>")
    .description("change a setting in the project config (use --global for ~/.codify)")
    .option("-g, --global", "write to the user config instead of the project")
    .action((key: string, value: string, o: { global?: boolean }) => {
      const file = o.global ? globalConfigFile() : projectConfigFile(findProjectRoot());
      setConfigValue(file, key, parseConfigValue(value));
      process.stdout.write(`${pc.green("✔")} ${key} = ${value}  ${pc.dim(file)}\n`);
    });

  return program;
}

build()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    if (err instanceof MissingCredentialsError) process.stderr.write(pc.red(`${err.message}\n`));
    else process.stderr.write(pc.red(`✖ ${(err as Error).message ?? String(err)}\n`));
    process.exitCode = 1;
  });
