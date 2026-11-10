import type { TeamCredentials } from "../config/credentials.js";
import type { EngineEvent } from "../engine/events.js";
import type { RemoteContext } from "../tools/types.js";
import { TeamClient, TeamError, type FetchFn } from "./client.js";
import type { Identity } from "./identity.js";
import type { Policy } from "./policy.js";

/** A signed-in connection to a team server, used by the engine. */
export interface TeamSession {
  client: TeamClient;
  identity: Identity;
  policy: Policy;
}

export async function connectTeam(creds: TeamCredentials, fetchFn?: FetchFn): Promise<TeamSession> {
  const client = new TeamClient(creds.url, creds.token, fetchFn);
  try {
    const [identity, policy] = await Promise.all([client.me(), client.policy()]);
    return { client, identity, policy };
  } catch (err) {
    if (err instanceof TeamError && err.status === 401) {
      throw new Error(`Your team sign-in has expired or was revoked. Run \`codify login --team ${client.url}\` again.`);
    }
    throw new Error(`${(err as Error).message}. To work without the team server, run with CODIFY_TEAM=off or \`codify logout --team\`.`);
  }
}

export function remoteContext(session: TeamSession): RemoteContext {
  return {
    label: session.client.url,
    search: (query, opts) => session.client.search(query, opts),
    doc: (uri) => session.client.doc(uri),
  };
}

/**
 * Collects audit events during a turn and sends them to the team server.
 * Records metadata (tools, decisions, tokens); prompt text only when policy allows.
 */
export class AuditRecorder {
  private events: Array<Record<string, unknown>> = [];

  constructor(private readonly session: TeamSession) {}

  turnStart(sessionId: string, model: string, prompt: string): void {
    this.push({ type: "turn_start", sessionId, model, ...(this.session.policy.auditPrompts ? { prompt: prompt.slice(0, 4000) } : { promptChars: prompt.length }) });
  }

  record(ev: EngineEvent, sessionId: string): void {
    if (ev.type === "tool_call") this.push({ type: "tool_call", sessionId, tool: ev.name, description: ev.description.slice(0, 500) });
    else if (ev.type === "tool_result") this.push({ type: "tool_result", sessionId, tool: ev.name, ok: ev.ok, denied: ev.summary.startsWith("denied:"), summary: ev.summary.slice(0, 300) });
    else if (ev.type === "notice" && ev.level !== "info") this.push({ type: "notice", sessionId, level: ev.level, message: ev.message.slice(0, 300) });
    else if (ev.type === "usage") this.lastUsage = { ...ev.turn };
    else if (ev.type === "turn_end") this.push({ type: "turn_end", sessionId, stopReason: ev.stopReason, ...(this.lastUsage ?? {}) });
  }

  private lastUsage: Record<string, number> | null = null;

  private push(e: Record<string, unknown>): void {
    this.events.push({ ts: new Date().toISOString(), ...e });
  }

  /** Send what was collected; never throws (audit must not break the user's turn). */
  async flush(timeoutMs = 3000): Promise<boolean> {
    const batch = this.events.splice(0);
    if (!batch.length) return true;
    try {
      await Promise.race([this.session.client.audit(batch), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs).unref())]);
      return true;
    } catch {
      this.events.unshift(...batch.slice(-200));
      return false;
    }
  }
}
