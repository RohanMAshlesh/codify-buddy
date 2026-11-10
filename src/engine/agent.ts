import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config/config.js";
import { describeApiError } from "../model/client.js";
import { addUsage, emptyUsage, estimateCost, type Usage } from "../model/pricing.js";
import { ToolInputParseError, type ModelTransport, type StreamParams } from "../model/transport.js";
import type { PermissionGate } from "../tools/permissions.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ProposedChange, ToolContext } from "../tools/types.js";
import type { EventSink } from "./events.js";
import { BASE_SYSTEM_PROMPT } from "./prompt.js";
import type { SessionData } from "./session.js";

type Block = Anthropic.Beta.BetaContentBlock;
type ToolUse = Anthropic.Beta.BetaToolUseBlock;
type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;

export interface AgentDeps {
  config: Config;
  transport: ModelTransport;
  tools: ToolRegistry;
  gate: PermissionGate;
  toolContext: ToolContext;
}

export interface TurnResult {
  text: string;
  stopReason: string;
  usage: Usage;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_JSON_RETRIES = 2;

function toUsage(u: Anthropic.Beta.BetaUsage): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function textOf(content: Block[]): string {
  return content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * The agent loop: stream a model turn, run requested tools through the
 * permission gate, feed results back, repeat until the model ends its turn.
 */
export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  buildParams(session: SessionData): StreamParams {
    const { config, tools } = this.deps;
    const params: StreamParams = {
      model: config.model,
      max_tokens: config.maxTokens,
      // Cache layout: tools → static prompt → frozen session context (breakpoint)
      // → conversation (top-level automatic breakpoint on the latest block).
      system: [
        { type: "text", text: BASE_SYSTEM_PROMPT },
        { type: "text", text: session.systemContext, cache_control: { type: "ephemeral" } },
      ],
      tools: tools.definitions(),
      messages: session.messages,
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: config.effort },
    };
    if (config.fallbacks) {
      params.betas = [FALLBACK_BETA];
      params.fallbacks = "default";
    }
    return params;
  }

  async runTurn(session: SessionData, userText: string, emit: EventSink, signal?: AbortSignal): Promise<TurnResult> {
    const { config, transport } = this.deps;
    const checkpoint = session.messages.length;
    session.messages.push({ role: "user", content: userText });
    if (!session.title) session.title = userText.replace(/\s+/g, " ").slice(0, 80);

    emit({ type: "turn_start" });
    let turnUsage = emptyUsage();
    let finalText = "";
    let jsonRetries = 0;

    const finish = (stopReason: string): TurnResult => {
      emit({ type: "turn_end", stopReason, text: finalText });
      return { text: finalText, stopReason, usage: turnUsage };
    };

    for (let iteration = 0; iteration < config.maxTurns; iteration++) {
      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await transport.stream(
          this.buildParams(session),
          { onText: (t) => emit({ type: "text", text: t }), onThinking: (t) => emit({ type: "thinking", text: t }) },
          signal,
        );
        jsonRetries = 0;
      } catch (err) {
        if (err instanceof ToolInputParseError && jsonRetries++ < MAX_JSON_RETRIES) {
          emit({ type: "notice", level: "warn", message: "A tool input arrived malformed; retrying the step." });
          continue;
        }
        if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
          this.rollbackIfNoProgress(session, checkpoint);
          return finish("interrupted");
        }
        this.rollbackIfNoProgress(session, checkpoint);
        emit({ type: "notice", level: "error", message: describeApiError(err) });
        return finish("error");
      }

      const usage = toUsage(message.usage);
      turnUsage = addUsage(turnUsage, usage);
      session.usage = addUsage(session.usage, usage);
      emit({ type: "usage", turn: turnUsage, session: session.usage, costUsd: estimateCost(config.model, session.usage) });

      const stop = message.stop_reason ?? "end_turn";
      if (stop === "refusal") {
        // Drop the refused turn entirely so the conversation stays valid.
        session.messages.length = checkpoint;
        const why = message.stop_details && "explanation" in message.stop_details ? message.stop_details.explanation : null;
        emit({ type: "notice", level: "warn", message: `The model declined this request${why ? `: ${why}` : "."}` });
        return finish("refusal");
      }

      session.messages.push({ role: "assistant", content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
      const text = textOf(message.content);
      if (text) finalText = text;

      if (stop === "pause_turn") continue;

      const toolUses = message.content.filter((b): b is ToolUse => b.type === "tool_use");
      if (toolUses.length === 0) {
        if (stop === "max_tokens") emit({ type: "notice", level: "warn", message: "The response hit the max_tokens limit and was cut off." });
        return finish(stop);
      }
      if (stop === "max_tokens") {
        // A tool input truncated at max_tokens may parse as a partial object: never run it.
        session.messages.push({
          role: "user",
          content: toolUses.map((t) => ({
            type: "tool_result" as const,
            tool_use_id: t.id,
            is_error: true,
            content: "Tool input was truncated by max_tokens and was not executed. Retry with a smaller step.",
          })),
        });
        continue;
      }

      const results = await this.runTools(toolUses, emit, signal);
      session.messages.push({ role: "user", content: results });
      if (signal?.aborted) return finish("interrupted");
    }

    emit({ type: "notice", level: "warn", message: `Stopped after ${config.maxTurns} model calls (maxTurns).` });
    return finish("max_turns");
  }

  /** If nothing but the user message was added, remove it so history stays alternating. */
  private rollbackIfNoProgress(session: SessionData, checkpoint: number): void {
    if (session.messages.length === checkpoint + 1) session.messages.length = checkpoint;
  }

  private async runTools(toolUses: ToolUse[], emit: EventSink, signal?: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const use of toolUses) {
      if (signal?.aborted) {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "Interrupted by the user before running." });
        continue;
      }
      results.push(await this.runTool(use, emit));
    }
    return results;
  }

  private async runTool(use: ToolUse, emit: EventSink): Promise<ToolResult> {
    const { tools, gate, toolContext } = this.deps;
    const fail = (content: string, summary = content): ToolResult => {
      emit({ type: "tool_result", id: use.id, name: use.name, ok: false, summary });
      return { type: "tool_result", tool_use_id: use.id, is_error: true, content };
    };

    const tool = tools.get(use.name);
    if (!tool) {
      emit({ type: "tool_call", id: use.id, name: use.name, description: use.name });
      return fail(`Unknown tool: ${use.name}`);
    }
    const parsed = tool.schema.safeParse(use.input);
    if (!parsed.success) {
      emit({ type: "tool_call", id: use.id, name: use.name, description: use.name });
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`).join("; ");
      return fail(`Invalid input for ${use.name}: ${issues}`, `invalid input for ${use.name}`);
    }
    const input = parsed.data;
    const description = tool.describe(input);
    emit({ type: "tool_call", id: use.id, name: use.name, description });

    try {
      let preview: string | undefined;
      let change: ProposedChange | undefined;
      if (gate.needsPrompt(tool)) {
        if (tool.preview) preview = await tool.preview(input, toolContext).catch(() => undefined);
        if (tool.proposed) change = await tool.proposed(input, toolContext).catch(() => undefined);
      }
      const verdict = await gate.check(tool, { tool: tool.name, access: tool.access, description, preview, change });
      if (verdict.decision === "deny") return fail(`Permission denied: ${verdict.reason}`, `denied: ${description}`);

      const out = await tool.run(input, toolContext);
      emit({ type: "tool_result", id: use.id, name: use.name, ok: !out.isError, summary: out.summary ?? description, diff: out.diff, display: out.display });
      return { type: "tool_result", tool_use_id: use.id, is_error: out.isError || undefined, content: out.content };
    } catch (err) {
      return fail(`Error: ${(err as Error).message}`);
    }
  }
}
