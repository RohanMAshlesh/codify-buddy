import { loadConfig, type Config, type ConfigOverrides } from "../config/config.js";
import { resolveCredentials, type Credentials } from "../config/credentials.js";
import { findProjectRoot } from "../config/paths.js";
import { ContextIndex, indexOptionsFor, type UpdateStats } from "../context/index.js";
import { buildRepoMap } from "../context/repomap.js";
import type { FetchLike } from "../connectors/http.js";
import { ConnectorManager } from "../connectors/manager.js";
import { McpHub, type McpServerStatus } from "../mcp/client.js";
import { createClient, createGatewayClient } from "../model/client.js";
import { resolveTeam } from "../config/credentials.js";
import { AuditRecorder, connectTeam, remoteContext, type TeamSession } from "../team/session.js";
import { clampMode, mcpServerAllowed, modelAllowed } from "../team/policy.js";
import { AnthropicTransport, type ModelTransport } from "../model/transport.js";
import { PermissionGate, type PermissionPrompter } from "../tools/permissions.js";
import { ToolRegistry } from "../tools/registry.js";
import { Agent, type TurnResult } from "./agent.js";
import type { EventSink } from "./events.js";
import { buildSessionContext, loadProjectMemory } from "./prompt.js";
import { loadSession, newSession, saveSession, type SessionData } from "./session.js";

export interface EngineOptions {
  cwd?: string;
  overrides?: ConfigOverrides;
  prompter?: PermissionPrompter;
  /** Inject a transport (tests, alternative providers). Defaults to the Anthropic API. */
  transport?: ModelTransport;
  credentials?: Credentials;
  /** Resume an existing session id. */
  resume?: string;
  /** Persist sessions to disk (default true). */
  persist?: boolean;
  /** HTTP client for connectors (tests). */
  fetch?: FetchLike;
  /**
   * Team server session. Omit to use the machine's team sign-in (Engine.open),
   * or pass null to work solo.
   */
  team?: TeamSession | null;
}

/**
 * The engine facade every client (CLI, IDE, CI) talks to. Owns config,
 * the context index, the current session and the agent loop.
 */
export class Engine {
  readonly root: string;
  readonly config: Config;
  readonly index: ContextIndex;
  readonly tools: ToolRegistry;
  readonly gate: PermissionGate;
  readonly connectors: ConnectorManager;
  readonly mcp = new McpHub();
  mcpStatus: McpServerStatus[] = [];
  private resumed: boolean;
  readonly team: TeamSession | null;
  /** Policy adjustments to tell the user about on the first turn. */
  private pendingNotices: string[] = [];
  session: SessionData;
  private agent: Agent;
  private readonly persist: boolean;
  lastIndexStats: UpdateStats | null = null;

  private constructor(opts: EngineOptions, transport: ModelTransport) {
    this.root = findProjectRoot(opts.cwd);
    this.config = loadConfig(this.root, opts.overrides);
    this.persist = opts.persist ?? true;
    this.index = new ContextIndex(this.root, indexOptionsFor(this.root, this.config));
    this.index.load();
    this.lastIndexStats = this.index.update();
    this.tools = new ToolRegistry();
    this.connectors = new ConnectorManager(this.config.connectors, { root: this.root, fetch: opts.fetch });
    for (const t of this.connectors.tools()) this.tools.register(t);
    this.gate = new PermissionGate(this.config.permissionMode, opts.prompter);
    this.team = opts.team ?? null;
    if (this.team) {
      const { policy } = this.team;
      const wanted = this.config.permissionMode;
      this.gate.maxMode = policy.maxPermissionMode;
      this.config.permissionMode = clampMode(wanted, policy.maxPermissionMode);
      if (this.gate.mode !== wanted) this.pendingNotices.push(`Team policy limits the permission mode to "${policy.maxPermissionMode}" (you asked for "${wanted}").`);
      if (!modelAllowed(this.config.model, policy)) {
        const from = this.config.model;
        this.config.model = policy.allowedModels[0]!;
        this.pendingNotices.push(`Team policy doesn't allow ${from}; using ${this.config.model}.`);
      }
    }

    const resumed = opts.resume ? loadSession(this.root, opts.resume) : null;
    if (opts.resume && !resumed) throw new Error(`Session not found: ${opts.resume}`);
    this.resumed = !!resumed;
    this.session = resumed ?? this.freshSession();
    this.agent = new Agent({
      config: this.config,
      transport,
      tools: this.tools,
      gate: this.gate,
      toolContext: { root: this.root, config: this.config, index: this.index, remote: this.team ? remoteContext(this.team) : undefined },
    });
  }

  static create(opts: EngineOptions = {}): Engine {
    let transport = opts.transport;
    if (!transport) {
      const creds = opts.credentials ?? resolveCredentials();
      const team = opts.team;
      // With a team sign-in, model traffic goes through the team gateway when policy
      // requires it or when there is no personal key.
      transport =
        team && (team.policy.requireGateway || creds.source === "none")
          ? new AnthropicTransport(createGatewayClient(team.client.gatewayUrl, team.client.bearer ?? ""))
          : new AnthropicTransport(createClient(creds));
    }
    return new Engine(opts, transport);
  }

  /**
   * Create an engine and connect its MCP servers. MCP tools are registered
   * before the session starts so the tool list (part of the cached prompt
   * prefix) is fixed for the whole session.
   */
  static async open(opts: EngineOptions = {}): Promise<Engine> {
    let team = opts.team;
    if (team === undefined) {
      const creds = resolveTeam();
      team = creds ? await connectTeam(creds) : null;
    }
    const engine = Engine.create({ ...opts, team });
    let servers = engine.config.mcp.servers;
    if (team) {
      const policy = team.policy;
      const allowed = Object.fromEntries(Object.entries(servers).filter(([name]) => mcpServerAllowed(name, policy)));
      for (const name of Object.keys(servers)) if (!(name in allowed)) engine.pendingNotices.push(`Team policy doesn't allow the MCP server "${name}"; it was not connected.`);
      servers = allowed;
    }
    if (Object.keys(servers).length) {
      engine.mcpStatus = await engine.mcp.connectAll(servers);
      for (const t of engine.mcp.tools()) if (!engine.tools.get(t.name)) engine.tools.register(t);
      if (!engine.resumed) engine.session = engine.freshSession();
    }
    return engine;
  }

  /** Release external resources (MCP server processes and connections). */
  async close(): Promise<void> {
    await this.mcp.close();
  }

  private freshSession(): SessionData {
    const systemContext = buildSessionContext({
      root: this.root,
      repoMap: buildRepoMap(this.index, this.config.context.repoMapTokens),
      sources: this.index.sources().map((src) => `${src.id} (${src.label}): ${src.docs} documents`),
      extraTools: this.mcpStatus.filter((m) => m.ok).map((m) => `MCP server "${m.name}": ${m.tools.length} tools (prefixed mcp__${m.name}__)`),
      memory: loadProjectMemory(this.root),
      date: new Date().toISOString().slice(0, 10),
    });
    return newSession(this.config.model, systemContext);
  }

  /** Start a new conversation (re-snapshots the repo map). */
  reset(): void {
    this.lastIndexStats = this.index.update();
    this.session = this.freshSession();
  }

  async send(text: string, emit: EventSink, signal?: AbortSignal): Promise<TurnResult> {
    for (const message of this.pendingNotices.splice(0)) emit({ type: "notice", level: "warn", message });
    let sink = emit;
    let audit: AuditRecorder | null = null;
    if (this.team) {
      try {
        const budget = await this.team.client.budget();
        if (budget.blocked) {
          emit({ type: "notice", level: "error", message: `Your monthly budget of $${budget.limitUsd} is used up ($${budget.usedUsd.toFixed(2)} in ${budget.month}). Ask a team admin to raise it.` });
          emit({ type: "turn_end", stopReason: "budget", text: "" });
          return { text: "", stopReason: "budget", usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
        }
        if (budget.warn) emit({ type: "notice", level: "warn", message: `You've used $${budget.usedUsd.toFixed(2)} of your $${budget.limitUsd} monthly budget.` });
      } catch {
        // The gateway enforces budgets too; don't block the turn on a status check.
      }
      const recorder = new AuditRecorder(this.team);
      recorder.turnStart(this.session.id, this.config.model, text);
      audit = recorder;
      sink = (ev) => {
        recorder.record(ev, this.session.id);
        emit(ev);
      };
    }
    // Keep the index fresh between turns; the repo map in the prompt stays frozen.
    this.lastIndexStats = this.index.update();
    const result = await this.agent.runTurn(this.session, text, sink, signal);
    if (this.persist && this.session.messages.length > 0) saveSession(this.root, this.session);
    await audit?.flush();
    return result;
  }
}
