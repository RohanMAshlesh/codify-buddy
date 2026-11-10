import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "../config/paths.js";
import type { Identity } from "./identity.js";

export interface TokenRecord {
  /** Short public id (first 8 chars of the hash) for listing and revoking. */
  id: string;
  kind: "session" | "pat";
  label?: string;
  identity: Identity;
  createdAt: string;
  expiresAt: string | null;
}

export interface UsageRecord {
  email: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface AuditEvent {
  ts: string;
  sub: string;
  email: string;
  type: string;
  [key: string]: unknown;
}

export interface AuditQuery {
  email?: string;
  since?: string;
  type?: string;
  limit?: number;
}

/**
 * File-backed team state: tokens, users, monthly usage and an append-only
 * audit log. One server process owns a data directory; writes are atomic
 * (write + rename). The interface is small so a database can replace it.
 */
export class FileStore {
  private tokens: Record<string, TokenRecord>;
  private usage: Record<string, Record<string, UsageRecord>>;

  constructor(readonly dir: string) {
    ensureDir(dir, 0o700);
    ensureDir(path.join(dir, "audit"), 0o700);
    this.tokens = this.read("tokens.json", {});
    this.usage = this.read("usage.json", {});
  }

  private read<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as T;
    } catch {
      return fallback;
    }
  }

  private write(name: string, value: unknown): void {
    const file = path.join(this.dir, name);
    fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(file + ".tmp", file);
  }

  // ---- tokens (stored by hash only) ----
  putToken(hash: string, record: TokenRecord): void {
    this.tokens[hash] = record;
    this.write("tokens.json", this.tokens);
  }

  getToken(hash: string): TokenRecord | undefined {
    return Object.hasOwn(this.tokens, hash) ? this.tokens[hash] : undefined;
  }

  listTokens(): TokenRecord[] {
    return Object.values(this.tokens).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Revoke by public id. Returns how many tokens were removed. */
  revokeToken(id: string): number {
    let n = 0;
    for (const [hash, rec] of Object.entries(this.tokens)) {
      if (rec.id === id) {
        delete this.tokens[hash];
        n++;
      }
    }
    if (n) this.write("tokens.json", this.tokens);
    return n;
  }

  pruneExpired(now = new Date()): number {
    let n = 0;
    for (const [hash, rec] of Object.entries(this.tokens)) {
      if (rec.expiresAt && new Date(rec.expiresAt) < now) {
        delete this.tokens[hash];
        n++;
      }
    }
    if (n) this.write("tokens.json", this.tokens);
    return n;
  }

  // ---- usage ----
  addUsage(month: string, sub: string, email: string, delta: Omit<UsageRecord, "email" | "requests">): UsageRecord {
    const m = (this.usage[month] ??= {});
    const cur = (m[sub] ??= { email, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
    cur.requests += 1;
    cur.inputTokens += delta.inputTokens;
    cur.outputTokens += delta.outputTokens;
    cur.cacheReadTokens += delta.cacheReadTokens;
    cur.cacheWriteTokens += delta.cacheWriteTokens;
    cur.costUsd = Math.round((cur.costUsd + delta.costUsd) * 1e6) / 1e6;
    this.write("usage.json", this.usage);
    return cur;
  }

  getUsage(month: string, sub: string): UsageRecord | undefined {
    return this.usage[month]?.[sub];
  }

  usageForMonth(month: string): Record<string, UsageRecord> {
    return this.usage[month] ?? {};
  }

  // ---- audit (JSON lines, one file per month) ----
  appendAudit(events: AuditEvent[]): void {
    if (!events.length) return;
    const byMonth = new Map<string, string[]>();
    for (const e of events) {
      const month = e.ts.slice(0, 7);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month)!.push(JSON.stringify(e));
    }
    for (const [month, lines] of byMonth) {
      fs.appendFileSync(path.join(this.dir, "audit", `${month}.jsonl`), lines.join("\n") + "\n", { mode: 0o600 });
    }
  }

  queryAudit(q: AuditQuery = {}): AuditEvent[] {
    const files = fs.readdirSync(path.join(this.dir, "audit")).filter((f) => f.endsWith(".jsonl")).sort();
    const out: AuditEvent[] = [];
    for (const f of files) {
      if (q.since && f.slice(0, 7) < q.since.slice(0, 7)) continue;
      for (const line of fs.readFileSync(path.join(this.dir, "audit", f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const e = JSON.parse(line) as AuditEvent;
        if (q.since && e.ts < q.since) continue;
        if (q.email && e.email !== q.email) continue;
        if (q.type && e.type !== q.type) continue;
        out.push(e);
      }
    }
    const limit = q.limit ?? 200;
    return out.slice(-limit);
  }
}

export const monthOf = (d = new Date()) => d.toISOString().slice(0, 7);
