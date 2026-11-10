import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { TeamConfig } from "./config.js";
import type { Identity } from "./identity.js";
import type { FileStore, TokenRecord } from "./store.js";

const TOKEN_PREFIX = "cbt_";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Issue a bearer token; only its hash is stored. */
export function issueToken(
  store: FileStore,
  identity: Identity,
  opts: { kind: TokenRecord["kind"]; ttlHours?: number | null; label?: string; now?: Date },
): { token: string; record: TokenRecord } {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
  const hash = hashToken(token);
  const now = opts.now ?? new Date();
  const record: TokenRecord = {
    id: hash.slice(0, 8),
    kind: opts.kind,
    label: opts.label,
    identity,
    createdAt: now.toISOString(),
    expiresAt: opts.ttlHours ? new Date(now.getTime() + opts.ttlHours * 3_600_000).toISOString() : null,
  };
  store.putToken(hash, record);
  return { token, record };
}

/** Resolve a bearer token to its identity, or null if unknown or expired. */
export function verifyToken(store: FileStore, token: string | undefined, now = new Date()): Identity | null {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;
  const rec = store.getToken(hashToken(token));
  if (!rec) return null;
  if (rec.expiresAt && new Date(rec.expiresAt) < now) return null;
  return rec.identity;
}

export function isAdmin(config: Pick<TeamConfig, "admins" | "adminGroups">, email: string, groups: string[]): boolean {
  const e = email.toLowerCase();
  return config.admins.some((a) => a.toLowerCase() === e) || groups.some((g) => config.adminGroups.includes(g));
}

interface Discovery {
  issuer: string;
  jwks_uri: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

export async function discover(issuer: string, fetchFn: typeof fetch = fetch): Promise<Discovery> {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  return (await res.json()) as Discovery;
}

/** Verifies ID tokens from the org's identity provider and maps them to identities. */
export class OidcVerifier {
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(private readonly config: TeamConfig) {}

  private async keys() {
    if (!this.jwks) {
      const d = await discover(this.config.oidc!.issuer);
      this.jwks = createRemoteJWKSet(new URL(d.jwks_uri));
    }
    return this.jwks;
  }

  async verify(idToken: string): Promise<Identity> {
    const oidc = this.config.oidc;
    if (!oidc) throw new Error("SSO is not configured on this team server");
    const { payload } = await jwtVerify(idToken, await this.keys(), { issuer: oidc.issuer, audience: oidc.clientId });
    return identityFromClaims(payload, oidc.groupsClaim, this.config);
  }
}

export function identityFromClaims(payload: JWTPayload, groupsClaim: string, config: Pick<TeamConfig, "admins" | "adminGroups">): Identity {
  const email = (payload.email ?? payload.preferred_username ?? payload.upn) as string | undefined;
  if (!email || !payload.sub) throw new Error("The ID token has no email or subject");
  if (payload.email_verified === false) throw new Error("The account's email address is not verified");
  const rawGroups = payload[groupsClaim];
  const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : [];
  return { sub: payload.sub, email, name: payload.name as string | undefined, groups, admin: isAdmin(config, email, groups) };
}
