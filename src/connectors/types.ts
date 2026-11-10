import type { ExternalDocInput } from "../context/index.js";
import type { Tool } from "../tools/types.js";
import type { FetchLike } from "./http.js";

export interface ConnectorRuntime {
  root: string;
  fetch: FetchLike;
  /** Resolve the secret for this connector (token / API key), if any. */
  secret(): string | undefined;
}

export interface TestResult {
  ok: boolean;
  detail: string;
}

export type ProgressFn = (message: string) => void;

/** A source of context outside the project (Confluence, GitHub, Jira, a docs folder). */
export interface Connector {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  /** Check credentials and reachability without syncing. */
  test(): Promise<TestResult>;
  /** Fetch documents to index locally. */
  sync(progress?: ProgressFn): Promise<ExternalDocInput[]>;
  /** Live, read-only tools the agent can call (search, fetch one item). */
  tools(): Tool<any>[];
}
