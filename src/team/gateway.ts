import type http from "node:http";
import { emptyUsage, estimateCost, type Usage } from "../model/pricing.js";
import type { TeamConfig } from "./config.js";
import type { Identity } from "./identity.js";
import { modelAllowed } from "./policy.js";
import { monthOf, type FileStore } from "./store.js";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** Anthropic-style error body, so SDK clients surface it as a typed APIError. */
export function anthropicError(res: http.ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

export interface BudgetStatus {
  month: string;
  limitUsd: number;
  usedUsd: number;
  remainingUsd: number | null;
  blocked: boolean;
  warn: boolean;
}

export function budgetFor(config: TeamConfig, store: FileStore, identity: Identity, now = new Date()): BudgetStatus {
  const month = monthOf(now);
  const used = store.getUsage(month, identity.sub)?.costUsd ?? 0;
  const limit = config.policy.monthlyBudgetUsd;
  if (!limit) return { month, limitUsd: 0, usedUsd: used, remainingUsd: null, blocked: false, warn: false };
  return {
    month,
    limitUsd: limit,
    usedUsd: used,
    remainingUsd: Math.max(0, Math.round((limit - used) * 100) / 100),
    blocked: used >= limit,
    warn: used >= limit * config.policy.budgetWarnAt,
  };
}

/** Accumulate token usage from Messages API streaming events. */
export function usageFromEvent(event: Record<string, unknown>, u: Usage): { usage: Usage; model?: string } {
  if (event.type === "message_start") {
    const msg = event.message as { model?: string; usage?: Record<string, number> } | undefined;
    const mu = msg?.usage ?? {};
    return {
      model: msg?.model,
      usage: {
        inputTokens: mu.input_tokens ?? 0,
        outputTokens: mu.output_tokens ?? 0,
        cacheReadTokens: mu.cache_read_input_tokens ?? 0,
        cacheWriteTokens: mu.cache_creation_input_tokens ?? 0,
      },
    };
  }
  if (event.type === "message_delta") {
    const du = (event.usage ?? {}) as Record<string, number>;
    return {
      usage: {
        inputTokens: du.input_tokens ?? u.inputTokens,
        outputTokens: du.output_tokens ?? u.outputTokens,
        cacheReadTokens: du.cache_read_input_tokens ?? u.cacheReadTokens,
        cacheWriteTokens: du.cache_creation_input_tokens ?? u.cacheWriteTokens,
      },
    };
  }
  return { usage: u };
}

export interface GatewayContext {
  config: TeamConfig;
  store: FileStore;
  fetch: FetchFn;
  env: NodeJS.ProcessEnv;
}

/**
 * Forward a Messages API request to Anthropic with the org's key, after
 * checking the caller's model and budget. Streams the response through and
 * meters its token usage against the caller.
 */
export async function forwardToAnthropic(
  ctx: GatewayContext,
  identity: Identity,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  upstreamPath: string,
  body: Buffer | null,
): Promise<void> {
  const apiKey = ctx.env[ctx.config.gateway.apiKeyEnv];
  if (!apiKey) return anthropicError(res, 500, "api_error", `The team gateway has no Anthropic API key (set ${ctx.config.gateway.apiKeyEnv} on the server).`);

  let requested: { model?: string; stream?: boolean } = {};
  if (body?.length) {
    try {
      requested = JSON.parse(body.toString("utf8"));
    } catch {
      return anthropicError(res, 400, "invalid_request_error", "Request body is not valid JSON");
    }
  }
  const isMessages = upstreamPath.startsWith("/v1/messages");
  if (isMessages && requested.model && !modelAllowed(requested.model, ctx.config.policy)) {
    return anthropicError(res, 403, "permission_error", `Model ${requested.model} is not allowed by ${ctx.config.org}'s policy. Allowed: ${ctx.config.policy.allowedModels.join(", ")}.`);
  }
  if (isMessages) {
    const budget = budgetFor(ctx.config, ctx.store, identity);
    if (budget.blocked) {
      return anthropicError(res, 403, "permission_error", `Monthly budget of $${budget.limitUsd} reached ($${budget.usedUsd.toFixed(2)} used in ${budget.month}). Ask an admin to raise it.`);
    }
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": String(req.headers["anthropic-version"] ?? "2023-06-01"),
  };
  if (req.headers["content-type"]) headers["content-type"] = String(req.headers["content-type"]);
  if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = String(req.headers["anthropic-beta"]);

  let upstream: Response;
  try {
    upstream = await ctx.fetch(`${ctx.config.gateway.upstream.replace(/\/+$/, "")}${upstreamPath}`, {
      method: req.method,
      headers,
      body: body?.length ? new Uint8Array(body) : undefined,
    });
  } catch (err) {
    return anthropicError(res, 502, "api_error", `Couldn't reach Anthropic from the team gateway: ${(err as Error).message}`);
  }

  const outHeaders: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
  const requestId = upstream.headers.get("request-id");
  if (requestId) outHeaders["request-id"] = requestId;
  res.writeHead(upstream.status, outHeaders);

  let usage = emptyUsage();
  let model = requested.model ?? "";
  const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (upstream.body) {
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      res.write(value);
      const text = decoder.decode(value, { stream: true });
      if (!isStream) {
        full += text;
        continue;
      }
      buffer += text;
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split("\n").find((l) => l.startsWith("data:"));
        if (!data) continue;
        try {
          const parsed = usageFromEvent(JSON.parse(data.slice(5).trim()), usage);
          usage = parsed.usage;
          if (parsed.model) model = parsed.model;
        } catch {
          // non-JSON keep-alives
        }
      }
    }
    if (!isStream && upstream.ok && full) {
      try {
        const json = JSON.parse(full) as { model?: string; usage?: Record<string, number> };
        if (json.usage) usage = usageFromEvent({ type: "message_start", message: json }, usage).usage;
        if (json.model) model = json.model;
      } catch {
        // not JSON
      }
    }
  }
  res.end();

  if (isMessages && upstream.ok && (usage.inputTokens || usage.outputTokens || usage.cacheReadTokens)) {
    const costUsd = estimateCost(model, usage) ?? 0;
    ctx.store.addUsage(monthOf(), identity.sub, identity.email, { ...usage, costUsd });
    ctx.store.appendAudit([{ ts: new Date().toISOString(), sub: identity.sub, email: identity.email, type: "model_request", model, ...usage, costUsd }]);
  }
}
