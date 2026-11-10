import { z } from "zod";
import { PERMISSION_MODES, type PermissionMode } from "../config/config.js";

/** Least to most permissive. */
const MODE_RANK: Record<PermissionMode, number> = { "read-only": 0, ask: 1, "auto-edit": 2, yolo: 3 };

export const PolicySchema = z.object({
  /** The most permissive mode anyone may use; requests above it are lowered to it. */
  maxPermissionMode: z.enum(PERMISSION_MODES).default("auto-edit"),
  /** Models people may use; empty = any. */
  allowedModels: z.array(z.string()).default([]),
  /** MCP server names people may connect; "*" = any, [] = none. */
  allowedMcpServers: z.union([z.literal("*"), z.array(z.string())]).default("*"),
  /** Route all model traffic through the team gateway (the org key never leaves the server). */
  requireGateway: z.boolean().default(true),
  /** Monthly model spend limit per person in USD; 0 = unlimited. */
  monthlyBudgetUsd: z.number().min(0).default(0),
  /** Fraction of the budget at which people are warned. */
  budgetWarnAt: z.number().min(0).max(1).default(0.8),
  /** Include prompt text in the audit log (off by default: metadata only). */
  auditPrompts: z.boolean().default(false),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

/** Lower a requested permission mode to the policy's maximum. */
export function clampMode(requested: PermissionMode, max: PermissionMode): PermissionMode {
  return MODE_RANK[requested] > MODE_RANK[max] ? max : requested;
}

export function modeAllowed(mode: PermissionMode, max: PermissionMode): boolean {
  return MODE_RANK[mode] <= MODE_RANK[max];
}

export function modelAllowed(model: string, policy: Pick<Policy, "allowedModels">): boolean {
  return policy.allowedModels.length === 0 || policy.allowedModels.includes(model);
}

export function mcpServerAllowed(name: string, policy: Pick<Policy, "allowedMcpServers">): boolean {
  return policy.allowedMcpServers === "*" || policy.allowedMcpServers.includes(name);
}
