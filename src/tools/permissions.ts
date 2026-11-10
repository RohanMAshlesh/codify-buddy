import type { PermissionMode } from "../config/config.js";
import type { Tool } from "./types.js";

export type PermissionDecision = "allow" | "deny";
export type PermissionAnswer = "allow" | "allow_always" | "deny";

export interface PermissionRequest {
  tool: string;
  access: Tool["access"];
  description: string;
  preview?: string;
}

export type PermissionPrompter = (req: PermissionRequest) => Promise<PermissionAnswer>;

/**
 * Decides whether a tool call may run. Reads always run; writes and shell
 * commands follow the mode, asking the user via `prompter` when required.
 */
export class PermissionGate {
  private alwaysAllowed = new Set<string>();

  constructor(public mode: PermissionMode, private readonly prompter?: PermissionPrompter) {}

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
