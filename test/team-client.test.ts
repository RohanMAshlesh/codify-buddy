import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveTeam, saveTeamCredentials } from "../src/config/credentials.js";
import { Engine } from "../src/engine/engine.js";
import type { EngineEvent } from "../src/engine/events.js";
import { issueToken } from "../src/team/auth.js";
import { loadTeamConfig } from "../src/team/config.js";
import type { FetchFn } from "../src/team/gateway.js";
import type { Identity } from "../src/team/identity.js";
import { loginWithSso, loginWithToken } from "../src/team/login.js";
import { TeamServer } from "../src/team/server.js";
import { makeTempDir } from "./helpers.js";
import { startMockIdp } from "./mock-idp.js";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** Scripted Anthropic upstream behind the gateway. */
function scriptedUpstream(script: Block[][]) {
  const requests: Array<{ headers: Record<string, string>; body: any }> = [];
  const fn: FetchFn = async (_url, init) => {
    const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString("utf8"));
    requests.push({ headers: init!.headers as Record<string, string>, body });
    const blocks = script.shift() ?? [{ type: "text", text: "(done)" }];
    const usage = { input_tokens: 2000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const events: object[] = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage } }];
    blocks.forEach((b, index) => {
      if (b.type === "text") {
        events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
      } else {
        events.push(
          { type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } },
          { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } },
        );
      }
      events.push({ type: "content_block_stop", index });
    });
    events.push({ type: "message_delta", delta: { stop_reason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" }, usage: { output_tokens: 1000 } }, { type: "message_stop" });
    return new Response(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  };
  return { fn, requests, script };
}

let idp: Awaited<ReturnType<typeof startMockIdp>>;
beforeAll(async () => {
  idp = await startMockIdp({ sub: "okta|alice", email: "alice@acme.com", name: "Alice", groups: ["engineering"] });
});
afterAll(() => idp.close());

const servers: TeamServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  delete process.env.CODIFY_TEAM_URL;
  delete process.env.CODIFY_TEAM_TOKEN;
});
beforeEach(() => {
  process.env.CODIFY_HOME = makeTempDir();
  process.env.NO_PROXY = "127.0.0.1";
  process.env.no_proxy = "127.0.0.1";
  delete process.env.ANTHROPIC_API_KEY;
});

async function startTeam(policy: Record<string, unknown>, script: Block[][] = []) {
  const dir = makeTempDir({
    "wiki/incidents.md": "# Incident Runbook\n\nPage the on-call engineer, then open a status page incident within 10 minutes.\n",
    "secret/salaries.md": "# Salaries\n\nConfidential compensation bands.\n",
  });
  fs.writeFileSync(
    path.join(dir, "team.json"),
    JSON.stringify({
      org: "Acme",
      oidc: { issuer: idp.issuer, clientId: idp.clientId },
      policy,
      sources: [
        { id: "runbooks", type: "docs", path: "wiki", label: "Runbooks", allow: ["group:engineering"] },
        { id: "hr", type: "docs", path: "secret", label: "HR", allow: ["group:hr"] },
      ],
      syncIntervalMinutes: 0,
    }),
  );
  const upstream = scriptedUpstream(script);
  const server = new TeamServer(loadTeamConfig(path.join(dir, "team.json")), { upstreamFetch: upstream.fn, env: { ANTHROPIC_API_KEY: "sk-ant-org-key" } });
  servers.push(server);
  const url = `http://127.0.0.1:${await server.listen(0)}`;
  await server.sync();
  return { server, url, upstream };
}

function project(files: Record<string, string> = {}) {
  return makeTempDir({ ".git/HEAD": "x", "src/pager.ts": "export function pageOnCall() {\n  return 'paged';\n}\n", ...files });
}

describe("team sign-in", () => {
  it("signs in with SSO (PKCE + loopback) and stores the session", async () => {
    const team = await startTeam({});
    const urls: string[] = [];
    // Stand in for the browser: follow the IdP redirect back to the CLI's loopback callback.
    const login = await loginWithSso(team.url, { openBrowser: async (u) => void (await fetch(u)), onUrl: (u) => urls.push(u) });
    expect(login.identity).toMatchObject({ email: "alice@acme.com", groups: ["engineering"] });
    expect(urls[0]).toContain("code_challenge_method=S256");
    saveTeamCredentials({ url: login.url, token: login.token, email: login.identity.email, expiresAt: login.expiresAt });
    expect(resolveTeam({})?.url).toBe(team.url);
    expect(resolveTeam({ CODIFY_TEAM: "off" })).toBeNull();
    expect(resolveTeam({ CODIFY_TEAM_URL: "https://ci", CODIFY_TEAM_TOKEN: "cbt_x" })).toEqual({ url: "https://ci", token: "cbt_x" });
  });

  it("signs in with an admin-issued token", async () => {
    const team = await startTeam({});
    const id: Identity = { sub: "ci", email: "ci@acme.com", groups: ["engineering"], admin: false };
    const { token } = issueToken(team.server.store, id, { kind: "pat", label: "ci" });
    expect((await loginWithToken(team.url, token)).identity).toEqual(id);
    await expect(loginWithToken(team.url, "cbt_bad")).rejects.toThrow(/Sign in/);
  });
});

describe("engine in team mode", () => {
  it("applies policy, routes through the gateway, merges team search and audits the turn", async () => {
    const team = await startTeam(
      { maxPermissionMode: "ask", allowedModels: ["claude-opus-5-5"], allowedMcpServers: [], monthlyBudgetUsd: 1 },
      [
        [{ type: "tool_use", id: "t1", name: "search_context", input: { query: "how do we page on-call during an incident" } }],
        [{ type: "text", text: "Page on-call per the Incident Runbook." }],
      ],
    );
    const id: Identity = { sub: "u-alice", email: "alice@acme.com", groups: ["engineering"], admin: false };
    process.env.CODIFY_TEAM_URL = team.url;
    process.env.CODIFY_TEAM_TOKEN = issueToken(team.server.store, id, { kind: "pat" }).token;

    const root = project({ ".codify/config.json": JSON.stringify({ mcp: { servers: { files: { command: "definitely-not-run", args: [] } } } }) });
    const engine = await Engine.open({ cwd: root, overrides: { permissionMode: "yolo", model: "claude-fable-5-2" } });
    expect(engine.team?.identity.email).toBe("alice@acme.com");
    expect(engine.gate.mode).toBe("ask");
    engine.gate.mode = "yolo";
    expect(engine.gate.mode).toBe("ask");
    expect(engine.config.model).toBe("claude-opus-5-5");
    expect(engine.mcpStatus).toEqual([]);

    const events: EngineEvent[] = [];
    const res = await engine.send("How do we page on-call?", (e) => events.push(e));
    expect(res).toMatchObject({ stopReason: "end_turn", text: "Page on-call per the Incident Runbook." });

    const notices = events.filter((e) => e.type === "notice").map((e) => (e as { message: string }).message);
    expect(notices.some((m) => m.includes('limits the permission mode to "ask"'))).toBe(true);
    expect(notices.some((m) => m.includes("doesn't allow claude-fable-5-2"))).toBe(true);
    expect(notices.some((m) => m.includes('MCP server "files"'))).toBe(true);

    // The tool result merged local code with the shared team runbook; HR stayed hidden.
    const toolResult = team.upstream.requests[1]!.body.messages.at(-1).content[0].content as string;
    expect(toolResult).toContain('source="runbooks"');
    expect(toolResult).toContain("src/pager.ts");
    expect(toolResult).not.toContain("Salaries");

    // Model traffic went through the gateway with the org key, never the user's token.
    expect(team.upstream.requests).toHaveLength(2);
    expect(team.upstream.requests[0]!.headers["x-api-key"]).toBe("sk-ant-org-key");
    expect(team.upstream.requests[0]!.body.model).toBe("claude-opus-5-5");

    const audit = team.server.store.queryAudit({ email: "alice@acme.com" });
    expect(audit.map((e) => e.type)).toEqual(expect.arrayContaining(["turn_start", "tool_call", "tool_result", "turn_end", "model_request"]));
    expect(audit.find((e) => e.type === "turn_start")).toMatchObject({ promptChars: 23 });
    expect(audit.find((e) => e.type === "turn_start")!.prompt).toBeUndefined();
    expect(team.server.store.usageForMonth(new Date().toISOString().slice(0, 7))["u-alice"]!.requests).toBe(2);
    await engine.close();
  }, 30_000);

  it("stops a turn when the monthly budget is used up", async () => {
    const team = await startTeam({ monthlyBudgetUsd: 0.000001 }, [[{ type: "text", text: "first" }]]);
    const id: Identity = { sub: "u-bob", email: "bob@acme.com", groups: ["engineering"], admin: false };
    const token = issueToken(team.server.store, id, { kind: "pat" }).token;
    process.env.CODIFY_TEAM_URL = team.url;
    process.env.CODIFY_TEAM_TOKEN = token;
    const engine = await Engine.open({ cwd: project() });
    expect((await engine.send("one", () => undefined)).stopReason).toBe("end_turn");
    const events: EngineEvent[] = [];
    const second = await engine.send("two", (e) => events.push(e));
    expect(second.stopReason).toBe("budget");
    expect(events.some((e) => e.type === "notice" && e.message.includes("monthly budget"))).toBe(true);
    expect(team.upstream.requests).toHaveLength(1);
    await engine.close();
  }, 30_000);

  it("explains an expired or revoked sign-in", async () => {
    const team = await startTeam({});
    process.env.CODIFY_TEAM_URL = team.url;
    process.env.CODIFY_TEAM_TOKEN = "cbt_revoked";
    await expect(Engine.open({ cwd: project() })).rejects.toThrow(/expired or was revoked/);
  });
});
