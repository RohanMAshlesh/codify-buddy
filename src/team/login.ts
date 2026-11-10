import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import { discover } from "./auth.js";
import { TeamClient, type FetchFn } from "./client.js";
import type { Identity } from "./identity.js";

export interface SsoLoginOptions {
  /** Opens the sign-in URL. Defaults to the system browser. */
  openBrowser?: (url: string) => Promise<void> | void;
  /** Called with the URL so the user can open it by hand. */
  onUrl?: (url: string) => void;
  fetch?: FetchFn;
  timeoutMs?: number;
}

export interface TeamLogin {
  url: string;
  token: string;
  expiresAt: string | null;
  identity: Identity;
}

export function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // the URL is also printed for manual opening
  }
}

/**
 * Sign in to a team server with the organisation's identity provider:
 * OAuth 2.0 authorization code + PKCE with a loopback redirect (RFC 8252),
 * then exchange the ID token for a Codify Buddy session token.
 */
export async function loginWithSso(teamUrl: string, opts: SsoLoginOptions = {}): Promise<TeamLogin> {
  const fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
  const team = new TeamClient(teamUrl, null, fetchFn);
  const cfg = await team.authConfig();
  if (!cfg.oidc) throw new Error(`${cfg.org}'s team server has no SSO configured. Ask an admin for a token and use \`codify login --team ${team.url} --token <token>\`.`);
  const d = await discover(cfg.oidc.issuer, fetchFn as typeof fetch);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const nonce = crypto.randomBytes(16).toString("base64url");

  // Loopback listener for the redirect.
  let resolveCode!: (code: string) => void;
  let rejectCode!: (err: Error) => void;
  const codePromise = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = u.searchParams.get("error");
    const page = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Codify Buddy</title><body style="font-family:system-ui;padding:40px"><h2>${msg}</h2><p>You can close this tab and return to the terminal.</p></body>`;
    if (error) {
      res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed"));
      rejectCode(new Error(`Sign-in failed: ${error} ${u.searchParams.get("error_description") ?? ""}`.trim()));
    } else if (u.searchParams.get("state") !== state) {
      res.writeHead(400, { "content-type": "text/html" }).end(page("Sign-in failed"));
      rejectCode(new Error("Sign-in failed: state mismatch"));
    } else {
      res.writeHead(200, { "content-type": "text/html" }).end(page(`Signed in to ${cfg.org}`));
      resolveCode(u.searchParams.get("code") ?? "");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const redirectUri = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;

  try {
    const auth = new URL(d.authorization_endpoint);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: cfg.oidc.clientId,
      redirect_uri: redirectUri,
      scope: cfg.oidc.scopes.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      nonce,
    }).toString();
    opts.onUrl?.(auth.toString());
    await (opts.openBrowser ?? openInBrowser)(auth.toString());

    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("Timed out waiting for sign-in")), opts.timeoutMs ?? 5 * 60_000).unref());
    const code = await Promise.race([codePromise, timeout]);

    const tokenRes = await fetchFn(d.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: cfg.oidc.clientId, code_verifier: verifier }).toString(),
    });
    const tokens = (await tokenRes.json()) as { id_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !tokens.id_token) throw new Error(`The identity provider refused the sign-in: ${tokens.error ?? tokenRes.status} ${tokens.error_description ?? ""}`.trim());

    const ex = await team.exchange(tokens.id_token);
    return { url: team.url, token: ex.token, expiresAt: ex.expiresAt, identity: ex.identity };
  } finally {
    server.close();
  }
}

/** Sign in with an admin-issued token (CI, or orgs without SSO). */
export async function loginWithToken(teamUrl: string, token: string, fetchFn?: FetchFn): Promise<TeamLogin> {
  const client = new TeamClient(teamUrl, token, fetchFn);
  const identity = await client.me();
  return { url: client.url, token, expiresAt: null, identity };
}
