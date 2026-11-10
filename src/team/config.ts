import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ConnectorConfigSchema } from "../config/config.js";
import { PolicySchema } from "./policy.js";

export const TeamSourceSchema = z.intersection(
  ConnectorConfigSchema,
  z.object({
    /** Who may search this source: `*`, `group:<name>`, `user:<email>`, `domain:<acme.com>`. Empty = admins only. */
    allow: z.array(z.string()).default([]),
  }),
);
export type TeamSource = z.infer<typeof TeamSourceSchema>;

export const TeamConfigSchema = z.object({
  org: z.string().min(1),
  /** Where the server keeps tokens, usage, audit logs and indexes (relative to the config file). */
  dataDir: z.string().default("./codify-team-data"),
  oidc: z
    .object({
      issuer: z.string().url(),
      clientId: z.string().min(1),
      scopes: z.array(z.string()).default(["openid", "email", "profile"]),
      groupsClaim: z.string().default("groups"),
    })
    .optional(),
  /** Emails and groups with admin rights (audit, usage, sync, tokens). */
  admins: z.array(z.string()).default([]),
  adminGroups: z.array(z.string()).default([]),
  /** How long a sign-in lasts. */
  sessionHours: z.number().int().positive().default(168),
  policy: PolicySchema.default(PolicySchema.parse({})),
  gateway: z
    .object({
      upstream: z.string().url().default("https://api.anthropic.com"),
      /** Environment variable holding the org's Anthropic API key. */
      apiKeyEnv: z.string().default("ANTHROPIC_API_KEY"),
    })
    .default({ upstream: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" }),
  sources: z.array(TeamSourceSchema).default([]),
  /** Re-sync team sources this often; 0 = only on demand. */
  syncIntervalMinutes: z.number().int().min(0).default(60),
});
export type TeamConfig = z.infer<typeof TeamConfigSchema>;

export interface LoadedTeamConfig {
  config: TeamConfig;
  /** Absolute data directory. */
  dataDir: string;
  /** Directory the config file lives in (relative paths resolve here). */
  baseDir: string;
}

export function loadTeamConfig(file: string): LoadedTeamConfig {
  const abs = path.resolve(file);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    throw new Error(`Can't read team config ${abs}: ${(err as Error).message}`);
  }
  const parsed = TeamConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid team config: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const baseDir = path.dirname(abs);
  return { config: parsed.data, dataDir: path.resolve(baseDir, parsed.data.dataDir), baseDir };
}

/** A starting config for `codify team init`. */
export function exampleTeamConfig(org: string): Record<string, unknown> {
  return {
    org,
    dataDir: "./codify-team-data",
    oidc: { issuer: "https://login.example.com/oauth2/default", clientId: "codify-cli", groupsClaim: "groups" },
    admins: ["you@example.com"],
    adminGroups: ["platform"],
    policy: {
      maxPermissionMode: "auto-edit",
      allowedModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
      allowedMcpServers: "*",
      requireGateway: true,
      monthlyBudgetUsd: 200,
      auditPrompts: false,
    },
    gateway: { upstream: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" },
    sources: [
      { id: "eng-wiki", type: "confluence", baseUrl: "https://example.atlassian.net/wiki", email: "svc-codify@example.com", spaces: ["ENG"], allow: ["group:engineering"] },
    ],
    syncIntervalMinutes: 60,
  };
}
