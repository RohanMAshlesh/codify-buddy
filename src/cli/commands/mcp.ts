import pc from "picocolors";
import { globalConfigFile, loadConfig, projectConfigFile, removeMcpServer, upsertMcpServer } from "../../config/config.js";
import { findProjectRoot } from "../../config/paths.js";
import { McpHub } from "../../mcp/client.js";

function pairs(list: string[] | undefined, what: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of list ?? []) {
    const i = item.indexOf("=");
    if (i <= 0) throw new Error(`Invalid ${what} "${item}"; use KEY=VALUE`);
    out[item.slice(0, i)] = item.slice(i + 1);
  }
  return out;
}

export interface McpAddOptions {
  url?: string;
  header?: string[];
  env?: string[];
  trusted?: boolean;
  global?: boolean;
}

/** `codify mcp add <name> [--url URL] -- <command> [args…]` */
export async function runMcpAdd(name: string, command: string[], o: McpAddOptions): Promise<number> {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) throw new Error("Server name must be 1-32 letters, digits, _ or -");
  if (!o.url && command.length === 0) throw new Error("Give a command after `--` (stdio server) or --url (HTTP server).");
  const server = o.url
    ? { url: o.url, headers: pairs(o.header, "header"), trusted: !!o.trusted }
    : { command: command[0]!, args: command.slice(1), env: pairs(o.env, "env"), trusted: !!o.trusted };

  process.stdout.write(pc.dim(`Connecting to ${name}…\n`));
  const hub = new McpHub();
  const [status] = await hub.connectAll({ [name]: server as never });
  await hub.close();
  if (!status?.ok) {
    process.stdout.write(pc.red(`✖ Could not connect: ${status?.error ?? "unknown error"}\n`));
    return 1;
  }
  const file = o.global ? globalConfigFile() : projectConfigFile(findProjectRoot());
  upsertMcpServer(file, name, server);
  process.stdout.write(pc.green(`✔ ${name}: ${status.tools.length} tools · saved to ${file}\n`));
  if (!o.trusted) process.stdout.write(pc.dim("  Tools that aren't marked read-only will ask before running (use --trusted to skip).\n"));
  return 0;
}

/** `codify mcp list`: connect to every configured server and show its tools. */
export async function runMcpList(): Promise<number> {
  const servers = loadConfig(findProjectRoot()).mcp.servers;
  if (!Object.keys(servers).length) {
    process.stdout.write(pc.dim("No MCP servers configured. Example:\n") + "  codify mcp add files -- npx -y @modelcontextprotocol/server-filesystem .\n");
    return 0;
  }
  const hub = new McpHub();
  const status = await hub.connectAll(servers);
  const tools = new Map(hub.tools().map((t) => [t.name, t]));
  await hub.close();
  for (const s of status) {
    const cfg = servers[s.name]!;
    const where = "url" in cfg ? cfg.url : [cfg.command, ...cfg.args].join(" ");
    process.stdout.write(`${s.ok ? pc.green("✔") : pc.red("✖")} ${pc.bold(s.name)} ${pc.dim(where)}${cfg.trusted ? pc.dim(" (trusted)") : ""}\n`);
    if (!s.ok) process.stdout.write(pc.red(`    ${s.error}\n`));
    for (const n of s.tools) process.stdout.write(`    ${n} ${pc.dim(tools.get(n)?.access === "read" ? "auto" : "asks")}\n`);
  }
  return status.every((s) => s.ok) ? 0 : 1;
}

export function runMcpRemove(name: string, o: { global?: boolean }): number {
  const ok = removeMcpServer(o.global ? globalConfigFile() : projectConfigFile(findProjectRoot()), name);
  process.stdout.write(ok ? pc.green(`✔ Removed ${name}\n`) : pc.red(`No MCP server named ${name}\n`));
  return ok ? 0 : 1;
}
