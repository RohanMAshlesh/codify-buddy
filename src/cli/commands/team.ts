import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { clearTeamCredentials, resolveTeam, saveTeamCredentials } from "../../config/credentials.js";
import { issueToken } from "../../team/auth.js";
import { exampleTeamConfig, loadTeamConfig } from "../../team/config.js";
import { TeamClient } from "../../team/client.js";
import type { Identity } from "../../team/identity.js";
import { loginWithSso, loginWithToken } from "../../team/login.js";
import { TeamServer } from "../../team/server.js";
import { FileStore, monthOf } from "../../team/store.js";

const out = (s = "") => process.stdout.write(s + "\n");

// ---- for everyone ----

export async function runTeamLogin(url: string, o: { token?: string; browser?: boolean }): Promise<number> {
  const login = o.token
    ? await loginWithToken(url, o.token)
    : await loginWithSso(url, {
        openBrowser: o.browser === false ? () => undefined : undefined,
        onUrl: (u) => out(pc.dim(`Opening your browser to sign in. If it doesn't open, visit:\n  ${u}`)),
      });
  saveTeamCredentials({ url: login.url, token: login.token, email: login.identity.email, expiresAt: login.expiresAt });
  out(pc.green(`✔ Signed in to ${login.url} as ${login.identity.email}${login.identity.admin ? " (admin)" : ""}`));
  if (login.identity.groups.length) out(pc.dim(`  groups: ${login.identity.groups.join(", ")}`));
  return 0;
}

export function runTeamLogout(): void {
  out(clearTeamCredentials() ? pc.green("✔ Signed out of the team server.") : pc.dim("Not signed in to a team server."));
}

export async function runTeamStatus(json = false): Promise<number> {
  const creds = resolveTeam();
  if (!creds) {
    out(pc.dim("Not signed in to a team server. Use `codify login --team <url>`."));
    return 1;
  }
  const client = new TeamClient(creds.url, creds.token);
  const [me, policy, budget, sources] = await Promise.all([client.me(), client.policy(), client.budget(), client.sources()]);
  if (json) {
    out(JSON.stringify({ url: creds.url, me, policy, budget, sources }, null, 2));
    return 0;
  }
  out(`${pc.bold("Team")}     ${creds.url}`);
  out(`${pc.bold("You")}      ${me.email}${me.admin ? " (admin)" : ""}${me.groups.length ? pc.dim(` · ${me.groups.join(", ")}`) : ""}`);
  out(`${pc.bold("Policy")}   max mode ${policy.maxPermissionMode} · models ${policy.allowedModels.join(", ") || "any"} · MCP ${policy.allowedMcpServers === "*" ? "any" : policy.allowedMcpServers.join(", ") || "none"} · gateway ${policy.requireGateway ? "required" : "optional"}`);
  out(`${pc.bold("Budget")}   ${budget.limitUsd ? `$${budget.usedUsd.toFixed(2)} of $${budget.limitUsd} in ${budget.month}${budget.blocked ? pc.red(" · used up") : budget.warn ? pc.yellow(" · nearly used") : ""}` : `unlimited · $${budget.usedUsd.toFixed(2)} used in ${budget.month}`}`);
  out(`${pc.bold("Sources")}  ${sources.length ? sources.map((s) => `@${s.id} (${s.docs})`).join(" · ") : pc.dim("none visible to you")}`);
  return 0;
}

// ---- admin (run on the server host) ----

export function runTeamInit(file: string, org: string): number {
  if (fs.existsSync(file)) {
    out(pc.red(`${file} already exists.`));
    return 1;
  }
  fs.writeFileSync(file, JSON.stringify(exampleTeamConfig(org), null, 2) + "\n");
  out(pc.green(`✔ Wrote ${file}`));
  out(pc.dim("  Edit the SSO issuer and client id, admins, policy and sources, then:"));
  out(`  ANTHROPIC_API_KEY=… codify team serve --config ${file}`);
  return 0;
}

export async function runTeamServe(configFile: string, o: { port?: string; host?: string }): Promise<void> {
  const loaded = loadTeamConfig(configFile);
  const server = new TeamServer(loaded, { log: (l) => out(pc.dim(`[${new Date().toISOString()}] ${l}`)) });
  const port = await server.listen(Number(o.port ?? process.env.PORT ?? 8787), o.host ?? process.env.HOST ?? "127.0.0.1");
  const key = process.env[loaded.config.gateway.apiKeyEnv] ? "set" : pc.yellow(`missing (${loaded.config.gateway.apiKeyEnv})`);
  out(pc.bold(pc.magenta(`◆ Codify Buddy team server · ${loaded.config.org}`)));
  out(pc.dim(`  listening on http://${o.host ?? "127.0.0.1"}:${port} · data ${loaded.dataDir}`));
  out(pc.dim(`  SSO ${loaded.config.oidc ? loaded.config.oidc.issuer : "off (tokens only)"} · gateway key ${key} · ${loaded.config.sources.length} sources`));
  const stop = async () => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

export function runTeamTokenCreate(configFile: string, o: { email: string; groups?: string; admin?: boolean; days?: string; label?: string }): number {
  const { dataDir } = loadTeamConfig(configFile);
  const store = new FileStore(dataDir);
  const identity: Identity = {
    sub: `token:${o.email}`,
    email: o.email,
    groups: (o.groups ?? "").split(",").map((g) => g.trim()).filter(Boolean),
    admin: !!o.admin,
  };
  const days = o.days ? Number(o.days) : 90;
  const { token, record } = issueToken(store, identity, { kind: "pat", ttlHours: days > 0 ? days * 24 : null, label: o.label });
  out(pc.green(`✔ Token ${record.id} for ${o.email}${record.expiresAt ? `, expires ${record.expiresAt.slice(0, 10)}` : ", no expiry"}`));
  out(`  ${token}`);
  out(pc.dim("  Shown once. Use it with `codify login --team <url> --token <token>` or CODIFY_TEAM_URL + CODIFY_TEAM_TOKEN in CI."));
  return 0;
}

export function runTeamTokenList(configFile: string): void {
  const store = new FileStore(loadTeamConfig(configFile).dataDir);
  store.pruneExpired();
  for (const t of store.listTokens()) {
    out(`${pc.cyan(t.id)}  ${t.kind.padEnd(7)} ${t.identity.email.padEnd(28)} ${pc.dim(`${t.createdAt.slice(0, 10)} → ${t.expiresAt?.slice(0, 10) ?? "never"}`)}${t.label ? `  ${t.label}` : ""}`);
  }
}

export function runTeamTokenRevoke(configFile: string, id: string): number {
  const n = new FileStore(loadTeamConfig(configFile).dataDir).revokeToken(id);
  out(n ? pc.green(`✔ Revoked ${id}`) : pc.red(`No token ${id}`));
  return n ? 0 : 1;
}

export async function runTeamSync(configFile: string, source?: string): Promise<number> {
  const server = new TeamServer(loadTeamConfig(configFile));
  const results = await server.sync(source);
  for (const r of results) out(r.ok ? `${pc.green("✔")} ${r.id} · ${r.docs} documents` : `${pc.red("✖")} ${r.id} · ${r.error}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

export function runTeamAudit(configFile: string, o: { email?: string; since?: string; type?: string; limit?: string; json?: boolean }): void {
  const store = new FileStore(loadTeamConfig(configFile).dataDir);
  const events = store.queryAudit({ email: o.email, since: o.since, type: o.type, limit: o.limit ? Number(o.limit) : 100 });
  if (o.json) {
    out(JSON.stringify(events, null, 2));
    return;
  }
  for (const e of events) {
    const { ts, email, type, sub: _sub, ...rest } = e;
    const detail = Object.entries(rest)
      .filter(([k]) => k !== "sessionId")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    out(`${pc.dim(ts.slice(0, 19).replace("T", " "))}  ${email.padEnd(24)} ${pc.cyan(type.padEnd(14))} ${detail.slice(0, 160)}`);
  }
}

export function runTeamUsage(configFile: string, o: { month?: string; json?: boolean }): void {
  const loaded = loadTeamConfig(configFile);
  const month = o.month ?? monthOf();
  const usage = new FileStore(loaded.dataDir).usageForMonth(month);
  if (o.json) {
    out(JSON.stringify(usage, null, 2));
    return;
  }
  const rows = Object.values(usage).sort((a, b) => b.costUsd - a.costUsd);
  out(pc.bold(`Usage in ${month}`) + pc.dim(loaded.config.policy.monthlyBudgetUsd ? ` · budget $${loaded.config.policy.monthlyBudgetUsd} per person` : ""));
  for (const r of rows) out(`${r.email.padEnd(28)} $${r.costUsd.toFixed(2).padStart(8)}  ${String(r.requests).padStart(5)} requests  ${pc.dim(`in ${r.inputTokens} · cached ${r.cacheReadTokens} · out ${r.outputTokens}`)}`);
  if (!rows.length) out(pc.dim("No usage yet."));
  out(pc.dim(`Total $${rows.reduce((s, r) => s + r.costUsd, 0).toFixed(2)}`));
}

export const defaultTeamConfig = () => path.resolve(process.env.CODIFY_TEAM_CONFIG ?? "team.json");
