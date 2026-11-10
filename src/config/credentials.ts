import fs from "node:fs";
import path from "node:path";
import { ensureDir, globalDir } from "./paths.js";

export type CredentialSource = "env:ANTHROPIC_API_KEY" | "env:ANTHROPIC_AUTH_TOKEN" | "file" | "none";

export interface Credentials {
  apiKey?: string;
  authToken?: string;
  source: CredentialSource;
}

export const credentialsFile = () => path.join(globalDir(), "credentials.json");

/** Resolve model credentials: environment first, then ~/.codify/credentials.json. */
export function resolveCredentials(env = process.env): Credentials {
  if (env.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY, source: "env:ANTHROPIC_API_KEY" };
  if (env.ANTHROPIC_AUTH_TOKEN) return { authToken: env.ANTHROPIC_AUTH_TOKEN, source: "env:ANTHROPIC_AUTH_TOKEN" };
  try {
    const data = JSON.parse(fs.readFileSync(credentialsFile(), "utf8")) as { anthropicApiKey?: string };
    if (data.anthropicApiKey) return { apiKey: data.anthropicApiKey, source: "file" };
  } catch {
    // no stored credentials
  }
  return { source: "none" };
}

/** Store an API key with owner-only permissions. */
export function saveApiKey(apiKey: string): string {
  ensureDir(globalDir(), 0o700);
  const file = credentialsFile();
  fs.writeFileSync(file, JSON.stringify({ anthropicApiKey: apiKey }, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function clearCredentials(): boolean {
  try {
    fs.unlinkSync(credentialsFile());
    return true;
  } catch {
    return false;
  }
}

/** Show only enough of a key to recognise it. */
export function maskKey(key: string): string {
  return key.length <= 12 ? "****" : `${key.slice(0, 7)}…${key.slice(-4)}`;
}
