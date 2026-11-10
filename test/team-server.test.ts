import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { issueToken } from "../src/team/auth.js";
import { loadTeamConfig } from "../src/team/config.js";
import { usageFromEvent, type FetchFn } from "../src/team/gateway.js";
import type { Identity } from "../src/team/identity.js";
import { TeamServer } from "../src/team/server.js";
import { makeTempDir } from "./helpers.js";
import { startMockIdp } from "./mock-idp.js";

const alice: Identity = { sub: "u-alice", email: "alice@acme.com", groups: ["engineering"], admin: false };
const bob: Identity = { sub: "u-bob", email: "bob@acme.com", groups: ["finance"], admin: false };
const carol: Identity = { sub: "u-carol", email: "carol@acme.com", groups: [], admin: true };

/** Fake Anthropic upstream: records requests, streams a response with usage. */
function fakeUpstream() {
  const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fn: FetchFn = async (url, init) => {
    const headers = init?.headers as Record<string, string>;
    const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) : null;
    requests.push({ url, headers, body });
    const events = [
      { type: "message_start", message: { id: "m", model: body?.model ?? "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 500 } },
      { type: "message_stop" },
    ];
    const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1" } });
  };
  return { fn, requests };
}

let idp: Awaited<ReturnType<typeof startMockIdp>>;
beforeAll(async () => {
  idp = await startMockIdp({ sub: "okta|dana", email: "dana@acme.com", groups: ["engineering"] });
});
afterAll(() => idp.close());

const servers: TeamServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup(policy: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-org-key" }) {
  const dir = makeTempDir({
    "wiki-eng/deploys.md": "# Deploy Runbook\n\nBlue-green deploys run from the release branch.\n",
    "wiki-fin/payroll.md": "# Payroll Calendar\n\nPayroll runs on the 25th. Deploys are frozen that day.\n",
  });
  fs.writeFileSync(
    path.join(dir, "team.json"),
    JSON.stringify({
      org: "Acme",
      oidc: { issuer: idp.issuer, clientId: idp.clientId },
      policy: { allowedModels: ["claude-opus-5-5"], maxPermissionMode: "auto-edit", ...policy },
      sources: [
        { id: "eng-wiki", type: "docs", path: "wiki-eng", label: "Engineering wiki", allow: ["group:engineering"] },
        { id: "finance", type: "docs", path: "wiki-fin", label: "Finance wiki", allow: ["group:finance"] },
      ],
      syncIntervalMinutes: 0,
    }),
  );
  const upstream = fakeUpstream();
  const server = new TeamServer(loadTeamConfig(path.join(dir, "team.json")), { upstreamFetch: upstream.fn, env });
  servers.push(server);
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const tok = (id: Identity) => issueToken(server.store, id, { kind: "pat", ttlHours: 1 }).token;
  const call = async (p: string, token?: string, init: RequestInit = {}) => {
    const res = await fetch(base + p, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(init.headers as Record<string, string>) } });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      // stream text
    }
    return { status: res.status, body, headers: res.headers };
  };
  return { base, call, tok, upstream, server };
}

describe("TeamServer basics", () => {
  it("serves health and auth config, and requires a token elsewhere", async () => {
    const t = await setup();
    expect((await t.call("/healthz")).body).toMatchObject({ ok: true, org: "Acme" });
    expect((await t.call("/v1/auth/config")).body).toEqual({ org: "Acme", oidc: { issuer: idp.issuer, clientId: idp.clientId, scopes: ["openid", "email", "profile"] } });
    expect((await t.call("/v1/me")).status).toBe(401);
    expect((await t.call("/v1/me", "cbt_bogus")).status).toBe(401);
    expect((await t.call("/v1/me", t.tok(alice))).body).toEqual(alice);
    expect((await t.call("/v1/policy", t.tok(alice))).body).toMatchObject({ allowedModels: ["claude-opus-5-5"], maxPermissionMode: "auto-edit" });
  });

  it("exchanges an SSO ID token for a session token", async () => {
    const t = await setup();
    const ex = await t.call("/v1/auth/exchange", undefined, { method: "POST", body: JSON.stringify({ id_token: await idp.sign() }) });
    expect(ex.status).toBe(200);
    expect(ex.body.identity).toMatchObject({ email: "dana@acme.com", groups: ["engineering"], admin: false });
    expect((await t.call("/v1/me", ex.body.token)).body.email).toBe("dana@acme.com");
    const bad = await t.call("/v1/auth/exchange", undefined, { method: "POST", body: JSON.stringify({ id_token: await idp.sign({}, { aud: "other" }) }) });
    expect(bad.status).toBe(401);
  });
});

describe("shared, ACL-filtered context", () => {
  it("only returns documents from sources the caller may see", async () => {
    const t = await setup();
    expect(await t.server.sync()).toEqual([
      { id: "eng-wiki", ok: true, docs: 1 },
      { id: "finance", ok: true, docs: 1 },
    ]);
    const search = (who: Identity) => t.call("/v1/search", t.tok(who), { method: "POST", body: JSON.stringify({ query: "when are deploys frozen" }) });
    expect((await search(alice)).body.hits.map((h: any) => h.source)).toEqual(["eng-wiki"]);
    expect((await search(bob)).body.hits.map((h: any) => h.source)).toEqual(["finance"]);
    expect((await search(carol)).body.hits.map((h: any) => h.source).sort()).toEqual(["eng-wiki", "finance"]);

    expect((await t.call("/v1/sources", t.tok(alice))).body.map((s: any) => s.id)).toEqual(["eng-wiki"]);
    expect((await t.call("/v1/docs?uri=@finance/payroll", t.tok(alice))).status).toBe(404);
    const doc = await t.call("/v1/docs?uri=@finance/payroll", t.tok(bob));
    expect(doc.body).toMatchObject({ title: "Payroll Calendar", source: "finance" });
  });
});

describe("audit and admin", () => {
  it("records events under the caller's identity and limits admin routes", async () => {
    const t = await setup();
    const res = await t.call("/v1/audit", t.tok(alice), { method: "POST", body: JSON.stringify({ events: [{ type: "tool_call", tool: "run_command", email: "spoofed@evil.com" }, { nope: 1 }] }) });
    expect(res.body).toEqual({ accepted: 1 });
    expect((await t.call("/v1/admin/audit", t.tok(alice))).status).toBe(403);
    const log = (await t.call("/v1/admin/audit?type=tool_call", t.tok(carol))).body;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: "tool_call", tool: "run_command", email: "alice@acme.com", sub: "u-alice" });
    expect((await t.call("/v1/admin/tokens", t.tok(carol))).body.length).toBeGreaterThan(0);
  });
});

describe("model gateway", () => {
  it("forwards with the org key, streams through and meters usage", async () => {
    const t = await setup();
    const token = t.tok(alice);
    const res = await t.call("/gateway/v1/messages?beta=true", token, {
      method: "POST",
      headers: { "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01" },
      body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("text_delta");
    expect(res.headers.get("request-id")).toBe("req_1");
    const sent = t.upstream.requests[0]!;
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(sent.headers["x-api-key"]).toBe("sk-ant-org-key");
    expect(sent.headers["anthropic-beta"]).toBe("server-side-fallback-2026-07-01");
    expect(JSON.stringify(sent.headers)).not.toContain(token);

    const budget = (await t.call("/v1/budget", token)).body;
    expect(budget.usedUsd).toBeCloseTo((1000 * 4 + 500 * 20 + 2000 * 0.2) / 1e6, 6);
    const usage = (await t.call("/v1/admin/usage", t.tok(carol))).body;
    expect(usage["u-alice"]).toMatchObject({ requests: 1, inputTokens: 1000, outputTokens: 500, cacheReadTokens: 2000 });
  });

  it("enforces allowed models, budgets, auth and the org key", async () => {
    const t = await setup({ monthlyBudgetUsd: 0.01 });
    const send = (token: string | undefined, model = "claude-opus-5-5") =>
      t.call("/gateway/v1/messages", token, { method: "POST", body: JSON.stringify({ model, max_tokens: 5, stream: true, messages: [] }) });
    const token = t.tok(alice);
    const denied = await send(token, "claude-fable-5-2");
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ type: "permission_error" });
    expect((await send(undefined)).body.error.type).toBe("authentication_error");

    expect((await send(token)).status).toBe(200); // spends ~$0.0144, over the $0.01 budget
    const blocked = await send(token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/Monthly budget of \$0.01 reached/);
    expect((await t.call("/v1/budget", token)).body).toMatchObject({ blocked: true, limitUsd: 0.01 });
    expect(t.upstream.requests).toHaveLength(1);

    const noKey = await setup({}, {});
    const res = await noKey.call("/gateway/v1/messages", noKey.tok(alice), { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }) });
    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/no Anthropic API key/);
  });

  it("parses usage from streaming events", () => {
    let u = usageFromEvent({ type: "message_start", message: { model: "m", usage: { input_tokens: 5, cache_read_input_tokens: 7 } } }, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(u.model).toBe("m");
    u = usageFromEvent({ type: "message_delta", usage: { output_tokens: 9 } }, u.usage);
    expect(u.usage).toEqual({ inputTokens: 5, outputTokens: 9, cacheReadTokens: 7, cacheWriteTokens: 0 });
  });
});
