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
});

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

/** Parse a CLI string into a JSON value where possible ("12" → 12, "true" → true). */
export function parseConfigValue(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
