import type { SearchHit, SourceSummary } from "../context/index.js";
import type { BudgetStatus } from "./gateway.js";
import type { Identity } from "./identity.js";
import { PolicySchema, type Policy } from "./policy.js";
import type { AuditEvent, UsageRecord } from "./store.js";

export class TeamError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface TeamDoc {
  uri: string;
  title: string;
  url?: string;
  updatedAt?: string;
  source: string;
  sourceLabel: string;
  text: string;
}

/** HTTP client for a Codify Buddy team server. */
export class TeamClient {
  readonly url: string;

  constructor(url: string, private readonly token: string | null, private readonly fetchFn: FetchFn = (u, i) => fetch(u, i)) {
    this.url = url.replace(/\/+$/, "");
  }

  get gatewayUrl(): string {
    return `${this.url}/gateway`;
  }

  get bearer(): string | null {
    return this.token;
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url + path, {
        ...init,
        headers: { "content-type": "application/json", ...(this.token ? { authorization: `Bearer ${this.token}` } : {}), ...(init.headers as Record<string, string>) },
        signal: init.signal ?? AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new TeamError(`Can't reach the team server at ${this.url}: ${(err as Error).message}`, 0);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
      throw new TeamError(msg, res.status);
    }
    return body as T;
  }

  authConfig() {
    return this.call<{ org: string; oidc: { issuer: string; clientId: string; scopes: string[] } | null }>("/v1/auth/config");
  }
  exchange(idToken: string) {
    return this.call<{ token: string; expiresAt: string | null; identity: Identity }>("/v1/auth/exchange", { method: "POST", body: JSON.stringify({ id_token: idToken }) });
  }
  me() {
    return this.call<Identity>("/v1/me");
  }
  async policy(): Promise<Policy> {
    return PolicySchema.parse(await this.call("/v1/policy"));
  }
  budget() {
    return this.call<BudgetStatus>("/v1/budget");
  }
  sources() {
    return this.call<SourceSummary[]>("/v1/sources");
  }
  async search(query: string, opts: { limit?: number; budgetTokens?: number } = {}): Promise<SearchHit[]> {
    const res = await this.call<{ hits: SearchHit[] }>("/v1/search", { method: "POST", body: JSON.stringify({ query, ...opts }) });
    return res.hits;
  }
  async doc(uri: string): Promise<TeamDoc | null> {
    try {
      return await this.call<TeamDoc>(`/v1/docs?uri=${encodeURIComponent(uri)}`);
    } catch (err) {
      if (err instanceof TeamError && err.status === 404) return null;
      throw err;
    }
  }
  audit(events: Array<Record<string, unknown>>) {
    return this.call<{ accepted: number }>("/v1/audit", { method: "POST", body: JSON.stringify({ events }) });
  }

  // admin
  adminAudit(q: { email?: string; since?: string; type?: string; limit?: number } = {}) {
    const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    return this.call<AuditEvent[]>(`/v1/admin/audit?${params}`);
  }
  adminUsage(month?: string) {
    return this.call<Record<string, UsageRecord>>(`/v1/admin/usage${month ? `?month=${month}` : ""}`);
  }
  adminSync(source?: string) {
    return this.call<Array<{ id: string; ok: boolean; docs?: number; error?: string }>>("/v1/admin/sync", { method: "POST", body: JSON.stringify(source ? { source } : {}) });
  }
}
