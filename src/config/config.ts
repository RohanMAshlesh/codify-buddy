import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { globalDir, projectDir } from "./paths.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export const PERMISSION_MODES = ["ask", "auto-edit", "yolo", "read-only"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const ConfigSchema = z.object({
  model: z.string().default("claude-opus-5-5"),
  /** Cheaper model for background work (summaries, reranking). */
  smallModel: z.string().default("claude-haiku-5-5"),
  effort: z.enum(EFFORTS).default("medium"),
  maxTokens: z.number().int().positive().default(64000),
  permissionMode: z.enum(PERMISSION_MODES).default("ask"),
  /** Enable server-side refusal fallback (Claude API only). */
  fallbacks: z.boolean().default(true),
  /** Max agent iterations (model calls) per user turn. */
  maxTurns: z.number().int().positive().default(50),
  context: z
    .object({
      maxFileBytes: z.number().int().positive().default(1_000_000),
      /** Token budget for retrieved context injected per search. */
      budgetTokens: z.number().int().positive().default(12_000),
      /** Token budget for the repo map placed in the system prompt. */
      repoMapTokens: z.number().int().positive().default(3_000),
      extraIgnore: z.array(z.string()).default([]),
    })
    .default({ maxFileBytes: 1_000_000, budgetTokens: 12_000, repoMapTokens: 3_000, extraIgnore: [] }),
  /** Context sources beyond the project (see `codify connect`). */
  connectors: z.array(z.lazy(() => ConnectorConfigSchema)).default([]),
  mcp: z
    .object({ servers: z.record(z.string(), z.lazy(() => McpServerSchema)).default({}) })
    .default({ servers: {} }),
});

const connectorId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and dashes");

export const DocsConnectorSchema = z.object({
  id: connectorId,
  type: z.literal("docs"),
  label: z.string().optional(),
  /** Folder of .md/.txt/.html files (relative to the project root, or absolute). */
  path: z.string(),
});

export const GithubConnectorSchema = z.object({
  id: connectorId,
  type: z.literal("github"),
  label: z.string().optional(),
  /** `owner/name` */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
  apiUrl: z.string().url().default("https://api.github.com"),
  issues: z.boolean().default(true),
  pulls: z.boolean().default(true),
  state: z.enum(["all", "open"]).default("all"),
  limit: z.number().int().positive().max(5000).default(200),
  /** Fetch comment threads for this many of the most recently updated items. */
  commentsFor: z.number().int().min(0).max(500).default(30),
});

export const ConfluenceConnectorSchema = z.object({
  id: connectorId,
  type: z.literal("confluence"),
  label: z.string().optional(),
  /** e.g. https://acme.atlassian.net/wiki (Cloud) or https://confluence.acme.com (Data Center) */
  baseUrl: z.string().url(),
  flavor: z.enum(["cloud", "datacenter"]).default("cloud"),
  /** Atlassian account email (Cloud only; not secret). */
  email: z.string().optional(),
  spaces: z.array(z.string()).min(1),
  limit: z.number().int().positive().max(20_000).default(1000),
});

export const JiraConnectorSchema = z.object({
  id: connectorId,
  type: z.literal("jira"),
  label: z.string().optional(),
  baseUrl: z.string().url(),
  flavor: z.enum(["cloud", "datacenter"]).default("cloud"),
  email: z.string().optional(),
  /** Optional JQL for issues to index; live search tools work without it. */
  jql: z.string().optional(),
  limit: z.number().int().positive().max(10_000).default(300),
});

export const ConnectorConfigSchema = z.discriminatedUnion("type", [
  DocsConnectorSchema,
  GithubConnectorSchema,
  ConfluenceConnectorSchema,
  JiraConnectorSchema,
]);
export type ConnectorConfig = z.infer<typeof ConnectorConfigSchema>;

export const McpServerSchema = z.union([
  z.object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    /** Tools from this server run without asking (only for servers you trust). */
    trusted: z.boolean().default(false),
  }),
  z.object({
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).default({}),
    trusted: z.boolean().default(false),
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerSchema>;

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigOverrides = Partial<Omit<Config, "context">> & { context?: Partial<Config["context"]> };

function readJson(file: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
}

function envOverrides(env: NodeJS.ProcessEnv): ConfigOverrides {
  const out: ConfigOverrides = {};
  if (env.CODIFY_MODEL) out.model = env.CODIFY_MODEL;
  if (env.CODIFY_EFFORT) out.effort = env.CODIFY_EFFORT as Effort;
  if (env.CODIFY_PERMISSION_MODE) out.permissionMode = env.CODIFY_PERMISSION_MODE as PermissionMode;
  return out;
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    const prev = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object" && !Array.isArray(prev)) {
      out[k] = merge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const globalConfigFile = () => path.join(globalDir(), "config.json");
export const projectConfigFile = (root: string) => path.join(projectDir(root), "config.json");

/**
 * Resolve configuration. Precedence (lowest → highest):
 * defaults < ~/.codify/config.json < <root>/.codify/config.json < env < overrides.
 */
export function loadConfig(root: string, overrides: ConfigOverrides = {}, env = process.env): Config {
  let raw: Record<string, unknown> = {};
  raw = merge(raw, readJson(globalConfigFile()));
  raw = merge(raw, readJson(projectConfigFile(root)));
  raw = merge(raw, envOverrides(env) as Record<string, unknown>);
  raw = merge(raw, overrides as Record<string, unknown>);
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}

/** Set a single dotted key (e.g. `context.budgetTokens`) in a config file. */
export function setConfigValue(file: string, key: string, value: unknown): void {
  const data = readJson(file);
  const parts = key.split(".");
  let cur: Record<string, unknown> = data;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
  const candidate = ConfigSchema.safeParse(data);
  if (!candidate.success) {
    throw new Error(`Invalid value for ${key}: ${candidate.error.issues[0]?.message ?? "rejected"}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function writeValidated(file: string, data: Record<string, unknown>): void {
  const candidate = ConfigSchema.safeParse(data);
  if (!candidate.success) {
    const i = candidate.error.issues[0];
    throw new Error(`Invalid configuration: ${i ? `${i.path.join(".")}: ${i.message}` : "rejected"}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Add or replace (by id) a connector in a config file. */
export function upsertConnector(file: string, connector: Record<string, unknown>): void {
  const data = readJson(file);
  const list = Array.isArray(data.connectors) ? (data.connectors as Array<Record<string, unknown>>) : [];
  const i = list.findIndex((c) => c.id === connector.id);
  if (i >= 0) list[i] = connector;
  else list.push(connector);
  writeValidated(file, { ...data, connectors: list });
}

/** Remove a connector by id. Returns false when it wasn't in this file. */
export function removeConnector(file: string, id: string): boolean {
  const data = readJson(file);
  const list = Array.isArray(data.connectors) ? (data.connectors as Array<Record<string, unknown>>) : [];
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  writeValidated(file, { ...data, connectors: next });
  return true;
}

/** Add or replace an MCP server entry. */
export function upsertMcpServer(file: string, name: string, server: Record<string, unknown>): void {
  const data = readJson(file);
  const mcp = (data.mcp && typeof data.mcp === "object" ? data.mcp : {}) as { servers?: Record<string, unknown> };
  writeValidated(file, { ...data, mcp: { ...mcp, servers: { ...mcp.servers, [name]: server } } });
}

export function removeMcpServer(file: string, name: string): boolean {
  const data = readJson(file);
  const mcp = (data.mcp ?? {}) as { servers?: Record<string, unknown> };
  if (!mcp.servers?.[name]) return false;
  delete mcp.servers[name];
  writeValidated(file, { ...data, mcp });
  return true;
}

/** Parse a CLI string into a JSON value where possible ("12" → 12, "true" → true). */
export function parseConfigValue(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
