import type { z } from "zod";
import type { Config } from "../config/config.js";
import type { ContextIndex } from "../context/index.js";

/** `read` tools run freely; `write` and `exec` go through the permission gate. */
export type ToolAccess = "read" | "write" | "exec";

export interface ToolContext {
  root: string;
  config: Config;
  index: ContextIndex;
  signal?: AbortSignal;
}

export interface ToolOutput {
  /** Text returned to the model. */
  content: string;
  isError?: boolean;
  /** Short human summary for the UI ("Read src/a.ts (120 lines)"). */
  summary?: string;
  /** Optional diff preview for write tools. */
  diff?: string;
  /** A few lines worth showing the user under the summary (e.g. failing tests). */
  display?: string;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  access: ToolAccess;
  schema: z.ZodType<I>;
  /** Raw JSON Schema sent to the model instead of one derived from `schema` (e.g. MCP tools). */
  jsonSchema?: Record<string, unknown>;
  /** One-line description of a specific call, used in permission prompts. */
  describe(input: I): string;
  /** Full before/after contents of a file change, so IDEs can show a native diff before approval. */
  proposed?(input: I, ctx: ToolContext): Promise<ProposedChange | undefined>;
  /** Optional preview (e.g. a diff) shown before asking permission. */
  preview?(input: I, ctx: ToolContext): Promise<string | undefined>;
  run(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ProposedChange {
  /** Project-relative POSIX path. */
  path: string;
  before: string;
  after: string;
  isNew: boolean;
}

export class ToolError extends Error {}
