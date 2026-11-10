import type { PermissionMode } from "../config/config.js";
import { clampMode } from "../team/policy.js";
import type { ProposedChange, Tool } from "./types.js";

export type PermissionDecision = "allow" | "deny";
export type PermissionAnswer = "allow" | "allow_always" | "deny";

export interface PermissionRequest {
  tool: string;
  access: Tool["access"];
  description: string;
  preview?: string;
  /** Full file contents before/after, for a native diff view. */
  change?: ProposedChange;
}

export type PermissionPrompter = (req: PermissionRequest) => Promise<PermissionAnswer>;

/**
 * Decides whether a tool call may run. Reads always run; writes and shell
 * commands follow the mode, asking the user via `prompter` when required.
 */
export class PermissionGate {
  private alwaysAllowed = new Set<string>();
  private current: PermissionMode;
  private max: PermissionMode | undefined;

  constructor(mode: PermissionMode, private readonly prompter?: PermissionPrompter) {
    this.current = mode;
  }

  /** The active mode. Setting it is clamped to `maxMode` when an org policy sets one. */
  get mode(): PermissionMode {
    return this.current;
  }
  set mode(m: PermissionMode) {
    this.current = this.max ? clampMode(m, this.max) : m;
  }

  /** The most permissive mode allowed (from team policy). Lowers the current mode if needed. */
  get maxMode(): PermissionMode | undefined {
    return this.max;
  }
  set maxMode(m: PermissionMode | undefined) {
    this.max = m;
    if (m) this.current = clampMode(this.current, m);
  }

  /** Pre-approve a tool for this session (same as answering "always"). */
  allowAlways(toolName: string): void {
    this.alwaysAllowed.add(toolName);
  }

  needsPrompt(tool: Tool): boolean {
    if (tool.access === "read") return false;
    if (this.mode === "yolo" || this.mode === "read-only") return false;
    if (this.mode === "auto-edit" && tool.access === "write") return false;
    return !this.alwaysAllowed.has(tool.name);
  }

  async check(tool: Tool, req: PermissionRequest): Promise<{ decision: PermissionDecision; reason?: string }> {
    if (tool.access === "read") return { decision: "allow" };
    if (this.mode === "read-only") return { decision: "deny", reason: "read-only mode: writes and commands are disabled" };
    if (!this.needsPrompt(tool)) return { decision: "allow" };
    if (!this.prompter) return { decision: "deny", reason: "no interactive approval available (pass --mode auto-edit or yolo)" };
    const answer = await this.prompter(req);
    if (answer === "allow_always") this.alwaysAllowed.add(tool.name);
    return answer === "deny" ? { decision: "deny", reason: "the user declined this action" } : { decision: "allow" };
  }
}
