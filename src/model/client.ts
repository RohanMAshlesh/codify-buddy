import Anthropic from "@anthropic-ai/sdk";
import type { Credentials } from "../config/credentials.js";

export class MissingCredentialsError extends Error {
  constructor() {
    super("No model credentials found. Run `codify login` or set ANTHROPIC_API_KEY.");
  }
}

export function createClient(creds: Credentials): Anthropic {
  if (creds.apiKey) return new Anthropic({ apiKey: creds.apiKey });
  if (creds.authToken) return new Anthropic({ authToken: creds.authToken, apiKey: null });
  throw new MissingCredentialsError();
}

/** A client that sends model traffic through a team server's gateway with the user's team token. */
export function createGatewayClient(baseURL: string, token: string): Anthropic {
  return new Anthropic({ baseURL, authToken: token, apiKey: null });
}

/** Human-readable explanation for an API error, with a hint where possible. */
export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Authentication failed: the API key was rejected. Run `codify login` to update it.";
  if (err instanceof Anthropic.PermissionDeniedError) return `Permission denied: ${err.message}`;
  if (err instanceof Anthropic.NotFoundError) return `Not found (check the model name): ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API. Wait a moment and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Bad request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check your network or proxy settings.";
  if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
