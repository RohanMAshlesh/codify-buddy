import type { ConnectorConfig } from "../config/config.js";
import { resolveSecret } from "../config/credentials.js";
import type { ContextIndex, SourceSummary } from "../context/index.js";
import type { Tool } from "../tools/types.js";
import { ConfluenceConnector } from "./confluence.js";
import { DocsConnector } from "./docs.js";
import { GithubConnector } from "./github.js";
import type { FetchLike } from "./http.js";
import { JiraConnector } from "./jira.js";
import type { Connector, ConnectorRuntime, ProgressFn } from "./types.js";

export interface ManagerOptions {
  root: string;
  fetch?: FetchLike;
  /** Override secret resolution (tests). */
  secret?: (cfg: ConnectorConfig) => string | undefined;
}

function baseUrlOf(cfg: ConnectorConfig): string {
  switch (cfg.type) {
    case "github":
      return cfg.apiUrl;
    case "confluence":
    case "jira":
      return cfg.baseUrl;
    default:
      return "";
  }
}

export function createConnector(cfg: ConnectorConfig, opts: ManagerOptions): Connector {
  let cached: { value?: string } | null = null;
  const rt: ConnectorRuntime = {
    root: opts.root,
    fetch: opts.fetch ?? ((url, init) => fetch(url, init)),
    secret: () => {
      if (cfg.type === "docs") return undefined;
      if (!cached) cached = { value: opts.secret ? opts.secret(cfg) : resolveSecret(cfg.type, baseUrlOf(cfg)).value };
      return cached.value;
    },
  };
  switch (cfg.type) {
    case "docs":
      return new DocsConnector(cfg, rt);
    case "github":
      return new GithubConnector(cfg, rt);
    case "confluence":
      return new ConfluenceConnector(cfg, rt);
    case "jira":
      return new JiraConnector(cfg, rt);
  }
}

export interface ConnectorStatus {
  id: string;
  type: string;
  label: string;
  synced?: SourceSummary;
}

/** Owns the configured connectors: their live tools, sync and status. */
export class ConnectorManager {
  readonly connectors: Connector[];

  constructor(configs: ConnectorConfig[], private readonly opts: ManagerOptions) {
    this.connectors = configs.map((c) => createConnector(c, opts));
  }

  get(id: string): Connector | undefined {
    return this.connectors.find((c) => c.id === id);
  }

  /** Live tools from every connector, in config order (stable for prompt caching). */
  tools(): Tool<any>[] {
    return this.connectors.flatMap((c) => c.tools());
  }

  status(index: ContextIndex): ConnectorStatus[] {
    const synced = new Map(index.sources().map((s) => [s.id, s]));
    return this.connectors.map((c) => ({ id: c.id, type: c.type, label: c.label, synced: synced.get(c.id) }));
  }

  /** Sync one connector into the index. */
  async sync(index: ContextIndex, id: string, progress?: ProgressFn): Promise<SourceSummary> {
    const c = this.get(id);
    if (!c) throw new Error(`No connector with id "${id}". Run \`codify connectors\` to list them.`);
    const docs = await c.sync(progress);
    return index.setExternalSource({ id: c.id, kind: c.type, label: c.label, docs });
  }
}
