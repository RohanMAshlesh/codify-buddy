import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, globalDir } from "./paths.js";

export type CredentialSource = "env:ANTHROPIC_API_KEY" | "env:ANTHROPIC_AUTH_TOKEN" | "file" | "none";

export interface Credentials {
  apiKey?: string;
  authToken?: string;
  source: CredentialSource;
}

interface Store {
  anthropicApiKey?: string;
  /** Connector secrets keyed by `<type>:<host>`, e.g. `confluence:acme.atlassian.net`. */
  secrets?: Record<string, string>;
}

export const credentialsFile = () => path.join(globalDir(), "credentials.json");

function readStore(): Store {
  try {
    return JSON.parse(fs.readFileSync(credentialsFile(), "utf8")) as Store;
  } catch {
    return {};
  }
}

function writeStore(store: Store): string {
  ensureDir(globalDir(), 0o700);
  const file = credentialsFile();
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Resolve model credentials: environment first, then ~/.codify/credentials.json. */
export function resolveCredentials(env = process.env): Credentials {
  if (env.ANTHROPIC_API_KEY) return { apiKey: env.ANTHROPIC_API_KEY, source: "env:ANTHROPIC_API_KEY" };
  if (env.ANTHROPIC_AUTH_TOKEN) return { authToken: env.ANTHROPIC_AUTH_TOKEN, source: "env:ANTHROPIC_AUTH_TOKEN" };
  const key = readStore().anthropicApiKey;
  return key ? { apiKey: key, source: "file" } : { source: "none" };
}

/** Store an API key with owner-only permissions, keeping other secrets. */
export function saveApiKey(apiKey: string): string {
  return writeStore({ ...readStore(), anthropicApiKey: apiKey });
}

/** Remove the stored API key (connector secrets are kept). */
export function clearCredentials(): boolean {
  const store = readStore();
  if (!store.anthropicApiKey) return false;
  delete store.anthropicApiKey;
  writeStore(store);
  return true;
}

export function getStoredSecret(key: string): string | undefined {
  return readStore().secrets?.[key];
}

export function setStoredSecret(key: string, value: string): string {
  const store = readStore();
  return writeStore({ ...store, secrets: { ...store.secrets, [key]: value } });
}

export function deleteStoredSecret(key: string): boolean {
  const store = readStore();
  if (!store.secrets?.[key]) return false;
  delete store.secrets[key];
  writeStore(store);
  return true;
}

/** Secret key for a connector service at a base URL: `<type>:<host>`. */
export function secretKey(type: string, baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // keep as-is
  }
  return `${type}:${host}`;
}

export interface SecretLookup {
  value?: string;
  source: string;
}

const ENV_SECRETS: Record<string, string[]> = {
  github: ["GITHUB_TOKEN", "GH_TOKEN"],
  confluence: ["CONFLUENCE_API_TOKEN", "ATLASSIAN_API_TOKEN"],
  jira: ["JIRA_API_TOKEN", "ATLASSIAN_API_TOKEN"],
};

/**
 * Resolve a connector secret: environment variables first, then the
 * credentials store, then (for GitHub) the `gh` CLI's token.
 */
export function resolveSecret(type: string, baseUrl: string, env = process.env, useGhCli = true): SecretLookup {
  for (const name of ENV_SECRETS[type] ?? []) if (env[name]) return { value: env[name], source: `env:${name}` };
  const stored = getStoredSecret(secretKey(type, baseUrl));
  if (stored) return { value: stored, source: "credentials file" };
  if (type === "github" && useGhCli) {
    try {
      const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (token) return { value: token, source: "gh CLI" };
    } catch {
      // gh not installed or not logged in
    }
  }
  return { source: "none" };
}

/** Show only enough of a key to recognise it. */
export function maskKey(key: string): string {
  return key.length <= 12 ? "****" : `${key.slice(0, 7)}…${key.slice(-4)}`;
}
