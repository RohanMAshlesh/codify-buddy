import { execFileSync } from "node:child_process";
import readline from "node:readline";
import pc from "picocolors";
import {
  ConnectorConfigSchema,
  globalConfigFile,
  loadConfig,
  projectConfigFile,
  removeConnector,
  upsertConnector,
  type ConnectorConfig,
} from "../../config/config.js";
import { deleteStoredSecret, resolveSecret, secretKey, setStoredSecret } from "../../config/credentials.js";
import { findProjectRoot } from "../../config/paths.js";
import { repoFromRemote } from "../../connectors/github.js";
import { ConnectorManager, createConnector } from "../../connectors/manager.js";
import { ContextIndex, indexOptionsFor } from "../../context/index.js";
import { askHidden } from "../prompt.js";

export const CONNECTOR_TYPES = ["github", "confluence", "jira", "docs"] as const;
export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ConnectOptions {
  id?: string;
  label?: string;
  repo?: string;
  url?: string;
  flavor?: "cloud" | "datacenter";
  email?: string;
  space?: string[];
  jql?: string;
  path?: string;
  global?: boolean;
  sync?: boolean;
  /** Never prompt; fail if something required is missing. */
  yes?: boolean;
}

const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

async function askText(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const hint = fallback ? pc.dim(` (${fallback})`) : "";
  const answer = await new Promise<string>((resolve) => rl.question(`${question}${hint}: `, (a) => resolve(a.trim())));
  rl.close();
  return answer || fallback || "";
}

function need(value: string | undefined, name: string, opts: ConnectOptions): string {
  if (value) return value;
  throw new Error(`Missing ${name}. Pass it as a flag${opts.yes ? "" : " or run in an interactive terminal"}.`);
}

function gitRemoteRepo(root: string): string | undefined {
  try {
    const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return repoFromRemote(remote) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Gather a connector config from flags, prompting for anything missing. */
async function buildConfig(type: ConnectorType, root: string, o: ConnectOptions): Promise<Record<string, unknown>> {
  const ask = interactive() && !o.yes;
  const id = o.id ?? type;
  switch (type) {
    case "docs": {
      const p = o.path ?? (ask ? await askText("Folder with docs (.md, .txt, .html)", "docs") : undefined);
      return { id, type, path: need(p, "--path", o), ...(o.label ? { label: o.label } : {}) };
    }
    case "github": {
      const detected = gitRemoteRepo(root);
      const repo = o.repo ?? (ask ? await askText("Repository (owner/name)", detected) : detected);
      return { id, type, repo: need(repo, "--repo", o), ...(o.label ? { label: o.label } : {}) };
    }
    case "confluence":
    case "jira": {
      const example = type === "confluence" ? "https://acme.atlassian.net/wiki" : "https://acme.atlassian.net";
      const url = o.url ?? (ask ? await askText(`${type === "confluence" ? "Confluence" : "Jira"} URL, e.g. ${example}`) : undefined);
      const baseUrl = need(url, "--url", o);
      const flavor = o.flavor ?? (/\.atlassian\.net/i.test(baseUrl) ? "cloud" : "datacenter");
      const email = flavor === "cloud" ? (o.email ?? (ask ? await askText("Atlassian account email") : undefined)) : undefined;
      if (flavor === "cloud") need(email, "--email", o);
      const base = { id, type, baseUrl, flavor, ...(email ? { email } : {}), ...(o.label ? { label: o.label } : {}) };
      if (type === "confluence") {
        let spaces = o.space;
        if (!spaces?.length && ask) spaces = (await askText("Space keys to index, comma separated (e.g. ENG,PAY)")).split(",").map((s) => s.trim()).filter(Boolean);
        if (!spaces?.length) throw new Error("Missing --space. Pass at least one Confluence space key.");
        return { ...base, spaces };
      }
      const jql = o.jql ?? (ask ? await askText("JQL for issues to index (blank = live search only)", "") : undefined);
      return { ...base, ...(jql ? { jql } : {}) };
    }
  }
}

function tokenHelp(type: ConnectorType, flavor?: string): string {
  if (type === "github") return "Create a fine-grained token with read access to issues and pull requests: https://github.com/settings/tokens";
  if (flavor === "datacenter") return "Create a personal access token in your profile (Profile → Personal Access Tokens).";
  return "Create an API token at https://id.atlassian.com/manage-profile/security/api-tokens";
}

/** `codify connect <type>`: configure, verify, save and (by default) sync. */
export async function runConnect(type: ConnectorType, o: ConnectOptions): Promise<number> {
  const root = findProjectRoot();
  const raw = await buildConfig(type, root, o);
  const parsed = ConnectorConfigSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Invalid connector settings: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const cfg = parsed.data;

  let secret: string | undefined;
  let secretToStore: string | undefined;
  if (cfg.type !== "docs") {
    const baseUrl = cfg.type === "github" ? cfg.apiUrl : cfg.baseUrl;
    const existing = resolveSecret(cfg.type, baseUrl);
    if (existing.value) {
      secret = existing.value;
      process.stdout.write(pc.dim(`Using token from ${existing.source}.\n`));
    } else if (interactive() && !o.yes) {
      process.stdout.write(pc.dim(tokenHelp(type, (cfg as { flavor?: string }).flavor) + "\n"));
      const entered = await askHidden(cfg.type === "github" ? "GitHub token (blank for public repos only): " : "API token: ");
      if (entered) secret = secretToStore = entered;
    }
  }

  process.stdout.write(pc.dim(`Testing ${cfg.type} connection…\n`));
  const connector = createConnector(cfg, { root, secret: () => secret });
  const result = await connector.test();
  if (!result.ok) {
    process.stdout.write(pc.red(`✖ ${result.detail}\n`));
    return 1;
  }
  process.stdout.write(pc.green(`✔ ${result.detail}\n`));

  const file = o.global ? globalConfigFile() : projectConfigFile(root);
  upsertConnector(file, raw);
  if (secretToStore && cfg.type !== "docs") {
    setStoredSecret(secretKey(cfg.type, cfg.type === "github" ? cfg.apiUrl : cfg.baseUrl), secretToStore);
  }
  process.stdout.write(pc.green(`✔ Saved connector "${cfg.id}" to ${file}\n`));

  if (o.sync !== false) return runSync([cfg.id]);
  process.stdout.write(pc.dim(`Run \`codify sync ${cfg.id}\` to index it.\n`));
  return 0;
}

/** `codify sync [ids...]`: pull documents from connectors into the local index. */
export async function runSync(ids: string[]): Promise<number> {
  const root = findProjectRoot();
  const config = loadConfig(root);
  const manager = new ConnectorManager(config.connectors, { root });
  const index = new ContextIndex(root, indexOptionsFor(root, config));
  index.load();
  const targets = ids.length ? ids : manager.connectors.map((c) => c.id);
  if (!targets.length) {
    process.stdout.write(pc.dim("No connectors configured. Try `codify connect github` or `codify connect docs`.\n"));
    return 0;
  }
  let failed = 0;
  for (const id of targets) {
    const t0 = Date.now();
    try {
      const s = await manager.sync(index, id, (msg) => process.stdout.write(pc.dim(`  ${id}: ${msg}\r`)));
      process.stdout.write(`\x1b[2K${pc.green("✔")} ${id} · ${s.docs} documents · ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
    } catch (err) {
      failed++;
      process.stdout.write(`\x1b[2K${pc.red("✖")} ${id} · ${(err as Error).message}\n`);
    }
  }
  return failed ? 1 : 0;
}

/** `codify connectors`: list configured connectors and their sync state. */
export function runConnectorsList(json = false): void {
  const root = findProjectRoot();
  const config = loadConfig(root);
  const index = new ContextIndex(root, indexOptionsFor(root, config));
  index.load();
  const status = new ConnectorManager(config.connectors, { root }).status(index);
  if (json) {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return;
  }
  if (!status.length) {
    process.stdout.write(
      pc.dim("No connectors yet. Add one:\n") +
        "  codify connect github       # issues and PRs for this repo\n" +
        "  codify connect confluence   # pages from Confluence spaces\n" +
        "  codify connect jira         # Jira issues (JQL)\n" +
        "  codify connect docs         # a local folder of notes or a wiki export\n",
    );
    return;
  }
  for (const s of status) {
    const synced = s.synced ? `${s.synced.docs} docs · synced ${s.synced.syncedAt.slice(0, 16).replace("T", " ")}` : pc.yellow("not synced");
    process.stdout.write(`${pc.cyan(s.id.padEnd(14))} ${s.type.padEnd(11)} ${s.label}  ${pc.dim(synced)}\n`);
  }
}

/** `codify disconnect <id>`: remove the connector, its synced documents and (optionally) its token. */
export function runDisconnect(id: string, o: { global?: boolean; forgetToken?: boolean }): number {
  const root = findProjectRoot();
  const config = loadConfig(root);
  const cfg: ConnectorConfig | undefined = config.connectors.find((c) => c.id === id);
  const removed = removeConnector(o.global ? globalConfigFile() : projectConfigFile(root), id);
  const index = new ContextIndex(root, indexOptionsFor(root, config));
  index.load();
  const dropped = index.removeExternalSource(id);
  if (o.forgetToken && cfg && cfg.type !== "docs") deleteStoredSecret(secretKey(cfg.type, cfg.type === "github" ? cfg.apiUrl : cfg.baseUrl));
  if (!removed && !dropped) {
    process.stdout.write(pc.red(`No connector "${id}" in the ${o.global ? "global" : "project"} config.\n`));
    return 1;
  }
  process.stdout.write(pc.green(`✔ Disconnected ${id}${dropped ? " and removed its indexed documents" : ""}.\n`));
  return 0;
}
