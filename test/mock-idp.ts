import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/**
 * A tiny OpenID Connect provider for tests: discovery, JWKS, an authorize
 * endpoint that immediately redirects back with a code, and a token endpoint
 * that checks PKCE and returns a signed ID token.
 */
export async function startMockIdp(user: { sub: string; email: string; name?: string; groups?: string[] }, clientId = "codify-cli") {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce?: string; redirect: string }>();
  let issuer = "";

  const sign = (claims: Record<string, unknown> = {}, opts: { aud?: string; iss?: string; exp?: string } = {}) =>
    new SignJWT({ email: user.email, name: user.name, groups: user.groups ?? [], email_verified: true, ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject(user.sub)
      .setIssuer(opts.iss ?? issuer)
      .setAudience(opts.aud ?? clientId)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? "10m")
      .sign(privateKey);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, { issuer, jwks_uri: `${issuer}/jwks`, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/authorize") {
      const code = `code-${codes.size + 1}`;
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, nonce: url.searchParams.get("nonce") ?? undefined, redirect: url.searchParams.get("redirect_uri")! });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state")!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body);
      const entry = codes.get(form.get("code") ?? "");
      const { createHash } = await import("node:crypto");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!entry || entry.challenge !== challenge || form.get("client_id") !== clientId) return json(400, { error: "invalid_grant" });
      return json(200, { id_token: await sign(entry.nonce ? { nonce: entry.nonce } : {}), token_type: "Bearer" });
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { issuer, clientId, sign, close: () => server.close() };
}
