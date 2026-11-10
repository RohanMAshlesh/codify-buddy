import http from "node:http";
import path from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { ensureDir } from "../config/paths.js";
import { ConnectorManager } from "../connectors/manager.js";
import { ContextIndex, type SourceSummary } from "../context/index.js";
import { issueToken, OidcVerifier, verifyToken } from "./auth.js";
import type { LoadedTeamConfig, TeamSource } from "./config.js";
import { anthropicError, budgetFor, forwardToAnthropic, type FetchFn } from "./gateway.js";
import { canAccess, type Identity } from "./identity.js";
import { FileStore, monthOf, type AuditEvent } from "./store.js";

const MAX_JSON = 1_000_000;
const MAX_GATEWAY = 32_000_000;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req, MAX_JSON);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export interface TeamServerOptions {
  /** HTTP client for the gateway's upstream (tests). */
  upstreamFetch?: FetchFn;
  env?: NodeJS.ProcessEnv;
  /** Override SSO verification (tests). */
  verifier?: { verify(idToken: string): Promise<Identity> };
  log?: (line: string) => void;
}

/**
 * The team server: SSO token exchange, org policy, budgets, shared
 * ACL-filtered search over team sources, an audit log and a model gateway.
 */
export class TeamServer {
  readonly store: FileStore;
  readonly index: ContextIndex;
  readonly connectors: ConnectorManager;
  private readonly sources: Map<string, TeamSource>;
  private readonly verifier: { verify(idToken: string): Promise<Identity> };
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<unknown> | null = null;

  constructor(readonly loaded: LoadedTeamConfig, private readonly opts: TeamServerOptions = {}) {
    const { config, dataDir, baseDir } = loaded;
    this.store = new FileStore(dataDir);
    const indexRoot = ensureDir(path.join(dataDir, "index"));
    this.index = new ContextIndex(indexRoot, { maxFileBytes: 1_000_000 });
    this.index.load();
    this.sources = new Map(config.sources.map((s) => [s.id, s]));
    this.connectors = new ConnectorManager(
      config.sources.map(({ allow: _allow, ...c }) => c as never),
      { root: baseDir },
    );
    this.verifier = opts.verifier ?? new OidcVerifier(config);
  }

  private get config() {
    return this.loaded.config;
  }

  private log(line: string) {
    this.opts.log?.(line);
  }

  // ---- lifecycle ----
  async listen(port = 8787, host = "127.0.0.1"): Promise<number> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, () => resolve()));
    const actual = (this.server.address() as { port: number }).port;
    if (this.config.syncIntervalMinutes > 0 && this.config.sources.length) {
      this.timer = setInterval(() => void this.sync().catch((e) => this.log(`sync failed: ${(e as Error).message}`)), this.config.syncIntervalMinutes * 60_000);
      this.timer.unref();
      const unsynced = this.config.sources.some((s) => !this.index.sources().some((x) => x.id === s.id));
      if (unsynced) void this.sync().catch((e) => this.log(`initial sync failed: ${(e as Error).message}`));
    }
    return actual;
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.syncing?.catch(() => undefined);
  }

  /** Sync one team source, or all of them. Returns per-source results. */
  async sync(sourceId?: string): Promise<Array<{ id: string; ok: boolean; docs?: number; error?: string }>> {
    while (this.syncing) await this.syncing.catch(() => undefined);
    const ids = sourceId ? [sourceId] : [...this.sources.keys()];
    const run = (async () => {
      const results: Array<{ id: string; ok: boolean; docs?: number; error?: string }> = [];
      for (const id of ids) {
        if (!this.sources.has(id)) {
          results.push({ id, ok: false, error: "unknown source" });
          continue;
        }
        try {
          const s = await this.connectors.sync(this.index, id);
          results.push({ id, ok: true, docs: s.docs });
          this.log(`synced ${id}: ${s.docs} documents`);
        } catch (err) {
          results.push({ id, ok: false, error: (err as Error).message });
          this.log(`sync ${id} failed: ${(err as Error).message}`);
        }
      }
      return results;
    })();
    this.syncing = run;
    try {
      return await run;
    } finally {
      this.syncing = null;
    }
  }

  // ---- helpers ----
  private identity(req: http.IncomingMessage): Identity {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : String(req.headers["x-api-key"] ?? "");
    const id = verifyToken(this.store, token || undefined);
    if (!id) throw new HttpError(401, "Sign in with `codify login --team <url>` (missing, invalid or expired token)");
    return id;
  }

  private visible(identity: Identity, sourceId: string): boolean {
    const s = this.sources.get(sourceId);
    return !!s && canAccess(identity, s.allow);
  }

  private visibleSources(identity: Identity): SourceSummary[] {
    return this.index.sources().filter((s) => this.visible(identity, s.id));
  }

  // ---- routing ----
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://local");
    const p = url.pathname;
    try {
      if (p.startsWith("/gateway/")) {
        let identity: Identity;
        try {
          identity = this.identity(req);
        } catch (err) {
          return anthropicError(res, 401, "authentication_error", (err as Error).message);
        }
        const body = req.method === "GET" || req.method === "HEAD" ? null : await readBody(req, MAX_GATEWAY);
        return await forwardToAnthropic(
          { config: this.config, store: this.store, fetch: this.opts.upstreamFetch ?? ((u, i) => fetch(u, i)), env: this.opts.env ?? process.env },
          identity,
          req,
          res,
          p.slice("/gateway".length) + url.search,
          body,
        );
      }

      if (p === "/healthz") return send(res, 200, { ok: true, org: this.config.org, version: pkg.version });
      if (p === "/v1/auth/config" && req.method === "GET") {
        const o = this.config.oidc;
        return send(res, 200, { org: this.config.org, oidc: o ? { issuer: o.issuer, clientId: o.clientId, scopes: o.scopes } : null });
      }
      if (p === "/v1/auth/exchange" && req.method === "POST") {
        const body = await readJson(req);
        if (typeof body.id_token !== "string") throw new HttpError(400, "id_token is required");
        let identity: Identity;
        try {
          identity = await this.verifier.verify(body.id_token);
        } catch (err) {
          throw new HttpError(401, `Sign-in rejected: ${(err as Error).message}`);
        }
        const { token, record } = issueToken(this.store, identity, { kind: "session", ttlHours: this.config.sessionHours, label: "sso" });
        this.store.appendAudit([{ ts: record.createdAt, sub: identity.sub, email: identity.email, type: "sign_in" }]);
        return send(res, 200, { token, expiresAt: record.expiresAt, identity });
      }

      const identity = this.identity(req);
      if (p === "/v1/me") return send(res, 200, identity);
      if (p === "/v1/policy") return send(res, 200, this.config.policy);
      if (p === "/v1/budget") return send(res, 200, budgetFor(this.config, this.store, identity));
      if (p === "/v1/sources") return send(res, 200, this.visibleSources(identity));
      if (p === "/v1/search" && req.method === "POST") {
        const body = await readJson(req);
        const query = String(body.query ?? "");
        if (!query.trim()) throw new HttpError(400, "query is required");
        const limit = typeof body.limit === "number" ? Math.min(Math.max(1, body.limit), 50) : 8;
        const result = this.index.search(query, {
          limit,
          scope: "docs",
          budgetTokens: typeof body.budgetTokens === "number" ? body.budgetTokens : undefined,
          sourceFilter: (id) => this.visible(identity, id),
        });
        return send(res, 200, { hits: result.hits, related: [], tokens: result.tokens });
      }
      if (p === "/v1/docs" && req.method === "GET") {
        const uri = url.searchParams.get("uri") ?? "";
        const doc = this.index.getExternalDoc(uri);
        if (!doc || !this.visible(identity, doc.source)) throw new HttpError(404, `No document at ${uri}`);
        return send(res, 200, { uri: doc.uri, title: doc.title, url: doc.url, updatedAt: doc.updatedAt, source: doc.source, sourceLabel: doc.sourceLabel, text: doc.text });
      }
      if (p === "/v1/audit" && req.method === "POST") {
        const body = await readJson(req);
        const events = Array.isArray(body.events) ? body.events.slice(0, 500) : [];
        const now = new Date().toISOString();
        const clean: AuditEvent[] = events
          .filter((e): e is Record<string, unknown> => !!e && typeof e === "object" && typeof (e as { type?: unknown }).type === "string")
          .map((e) => ({ ...e, ts: typeof e.ts === "string" ? e.ts : now, sub: identity.sub, email: identity.email, type: String(e.type).slice(0, 64) }));
        this.store.appendAudit(clean);
        return send(res, 200, { accepted: clean.length });
      }

      // ---- admin ----
      if (p.startsWith("/v1/admin/")) {
        if (!identity.admin) throw new HttpError(403, "Admins only");
        if (p === "/v1/admin/audit") {
          return send(res, 200, this.store.queryAudit({
            email: url.searchParams.get("email") ?? undefined,
            since: url.searchParams.get("since") ?? undefined,
            type: url.searchParams.get("type") ?? undefined,
            limit: Number(url.searchParams.get("limit") ?? 200),
          }));
        }
        if (p === "/v1/admin/usage") return send(res, 200, this.store.usageForMonth(url.searchParams.get("month") ?? monthOf()));
        if (p === "/v1/admin/sync" && req.method === "POST") {
          const body = await readJson(req);
          return send(res, 200, await this.sync(typeof body.source === "string" ? body.source : undefined));
        }
        if (p === "/v1/admin/tokens") return send(res, 200, this.store.listTokens().map((t) => ({ id: t.id, kind: t.kind, label: t.label, email: t.identity.email, createdAt: t.createdAt, expiresAt: t.expiresAt })));
      }
      throw new HttpError(404, `No route for ${req.method} ${p}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) this.log(`error on ${req.method} ${p}: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, status, { error: { message: status === 500 ? "Internal error" : (err as Error).message } });
      else res.end();
    }
  }
}
