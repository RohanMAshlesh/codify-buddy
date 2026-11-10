#!/usr/bin/env node
import readline from "node:readline";
import { Argument, Command, Option } from "commander";
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
import { ContextIndex, indexOptionsFor } from "../context/index.js";
import { Engine } from "../engine/engine.js";
import { listSessions } from "../engine/session.js";
import { MissingCredentialsError } from "../model/client.js";
import { CONNECTOR_TYPES, runConnect, runConnectorsList, runDisconnect, runSync, type ConnectorType } from "./commands/connect.js";
import { runDemo } from "./commands/demo.js";
import { runDoctor } from "./commands/doctor.js";
import { runMcpAdd, runMcpList, runMcpRemove } from "./commands/mcp.js";
import { serveMcp } from "../mcp/server.js";
import { runLogin, runLogout } from "./commands/login.js";
import { runOnce } from "./commands/run.js";
import { printSearch } from "./commands/search.js";
import { terminalPrompter } from "./prompt.js";
import { runRepl } from "./repl.js";
import { banner } from "./render.js";
import { serveStdio } from "../rpc/server.js";

/**
 * Read piped stdin (`cat log | codify "explain"`). When a prompt was given on
 * the command line, stdin is optional: if nothing arrives quickly we stop
 * waiting, so an open-but-idle pipe (common in CI) never hangs the CLI.
 */
async function readStdin(hasPrompt: boolean, graceMs = 150): Promise<string> {
  if (process.stdin.isTTY) return "";
  const stdin = process.stdin;
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let data = "";
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      stdin.off("data", onData);
      stdin.off("end", done);
      stdin.pause();
      resolve(data);
    };
    const onData = (chunk: string) => {
      data += chunk;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    stdin.on("data", onData);
    stdin.once("end", done);
    stdin.once("error", done);
    if (hasPrompt) timer = setTimeout(() => (data ? undefined : done()), graceMs);
  });
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

  let prompt = promptParts.join(" ").trim();
  const piped = await readStdin(prompt.length > 0);
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
  const engine = await Engine.open({
    overrides: {
      ...(opts.mode ? { permissionMode: opts.mode } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort as never } : {}),
    },
    prompter: terminalPrompter(() => rl),
    resume,
  });
  process.stdout.write(banner(engine.root, engine.index.fileCount, engine.config.model, engine.gate.mode) + "\n");
  const sources = engine.index.sources();
  if (sources.length) process.stdout.write(pc.dim(`  sources ${sources.map((x) => `${x.id} (${x.docs})`).join(" · ")}\n`));
  for (const m of engine.mcpStatus) {
    process.stdout.write(m.ok ? pc.dim(`  mcp ${m.name} · ${m.tools.length} tools\n`) : pc.yellow(`  ! mcp ${m.name} unavailable: ${m.error}\n`));
  }
  if (resume) process.stdout.write(pc.dim(`  resumed session ${resume}: ${engine.session.title}\n`));
  process.stdout.write("\n");
  await runRepl(engine, rl, { showThinking: opts.thinking });
  await engine.close();
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
    .command("demo [dir]")
    .description("create a sample project and walk through Codify Buddy (live with an API key, replayed without)")
    .option("--replay", "replay the recorded session even if an API key is set")
    .option("--live", "run live against the API (asks for a key if needed)")
    .option("--force", "overwrite an existing demo folder")
    .option("--fast", "replay without typing delays")
    .action(async (dir: string | undefined, o) => {
      process.exitCode = await runDemo(dir, o);
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
      const idx = new ContextIndex(root, indexOptionsFor(root, loadConfig(root)));
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
      const idx = new ContextIndex(root, indexOptionsFor(root, loadConfig(root)));
      idx.load();
      idx.update();
      printSearch(idx, query.join(" "), { limit: Number(o.limit), pathFilter: o.path, json: o.json });
    });

  program
    .command("connect")
    .description("connect a context source: github, confluence, jira or docs")
    .addArgument(new Argument("<type>", "source type").choices([...CONNECTOR_TYPES]))
    .option("--id <id>", "connector id (default: the type)")
    .option("--label <label>", "display name")
    .option("--repo <owner/name>", "GitHub repository (default: from git remote)")
    .option("--url <url>", "Confluence or Jira base URL")
    .addOption(new Option("--flavor <flavor>", "Atlassian deployment").choices(["cloud", "datacenter"]))
    .option("--email <email>", "Atlassian account email (Cloud)")
    .option("--space <keys...>", "Confluence space keys")
    .option("--jql <jql>", "Jira issues to index")
    .option("--path <dir>", "docs folder")
    .option("-g, --global", "save to ~/.codify instead of this project")
    .option("--no-sync", "don't index right away")
    .option("-y, --yes", "never prompt (for scripts)")
    .action(async (type: ConnectorType, o) => {
      process.exitCode = await runConnect(type, o);
    });

  program
    .command("connectors")
    .description("list connected sources and their sync status")
    .option("--json", "output JSON")
    .action((o: { json?: boolean }) => runConnectorsList(o.json));

  program
    .command("sync")
    .description("index documents from connected sources (all by default)")
    .argument("[ids...]")
    .action(async (ids: string[]) => {
      process.exitCode = await runSync(ids);
    });

  program
    .command("disconnect <id>")
    .description("remove a connector and its indexed documents")
    .option("-g, --global", "remove from ~/.codify config")
    .option("--forget-token", "also delete its stored token")
    .action((id: string, o: { global?: boolean; forgetToken?: boolean }) => {
      process.exitCode = runDisconnect(id, o);
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

  program
    .command("serve")
    .description("run the engine as a JSON-RPC server on stdio (used by IDE extensions)")
    .option("--stdio", "use stdin/stdout (default)")
    .action(async () => {
      await serveStdio();
    });

  const mcp = program.command("mcp").description("use MCP servers as tools, or serve Codify Buddy's context over MCP");
  mcp
    .command("add <name> [command...]")
    .description("add an MCP server: `codify mcp add files -- npx -y @modelcontextprotocol/server-filesystem .` or `--url`")
    .option("--url <url>", "streamable HTTP server URL")
    .option("--header <k=v...>", "HTTP headers")
    .option("--env <k=v...>", "environment variables for a stdio server")
    .option("--trusted", "run this server's tools without asking")
    .option("-g, --global", "save to ~/.codify")
    .action(async (name: string, command: string[], o) => {
      process.exitCode = await runMcpAdd(name, command, o);
    });
  mcp
    .command("list")
    .description("connect to configured MCP servers and list their tools")
    .action(async () => {
      process.exitCode = await runMcpList();
    });
  mcp
    .command("remove <name>")
    .description("remove an MCP server")
    .option("-g, --global", "remove from ~/.codify")
    .action((name: string, o: { global?: boolean }) => {
      process.exitCode = runMcpRemove(name, o);
    });
  mcp
    .command("serve")
    .description("serve this project's context (code + connected docs) as a read-only MCP server on stdio")
    .action(async () => {
      await serveMcp();
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
