import { loadConfig, type Config, type ConfigOverrides } from "../config/config.js";
import { resolveCredentials, type Credentials } from "../config/credentials.js";
import { findProjectRoot } from "../config/paths.js";
import { ContextIndex, type UpdateStats } from "../context/index.js";
import { buildRepoMap } from "../context/repomap.js";
import { createClient } from "../model/client.js";
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
  session: SessionData;
  private agent: Agent;
  private readonly persist: boolean;
  lastIndexStats: UpdateStats | null = null;

  private constructor(opts: EngineOptions, transport: ModelTransport) {
    this.root = findProjectRoot(opts.cwd);
    this.config = loadConfig(this.root, opts.overrides);
    this.persist = opts.persist ?? true;
    this.index = new ContextIndex(this.root, this.config.context);
    this.index.load();
    this.lastIndexStats = this.index.update();
    this.tools = new ToolRegistry();
    this.gate = new PermissionGate(this.config.permissionMode, opts.prompter);

    const resumed = opts.resume ? loadSession(this.root, opts.resume) : null;
    if (opts.resume && !resumed) throw new Error(`Session not found: ${opts.resume}`);
    this.session = resumed ?? this.freshSession();
    this.agent = new Agent({
      config: this.config,
      transport,
      tools: this.tools,
      gate: this.gate,
      toolContext: { root: this.root, config: this.config, index: this.index },
    });
  }

  static create(opts: EngineOptions = {}): Engine {
    const transport = opts.transport ?? new AnthropicTransport(createClient(opts.credentials ?? resolveCredentials()));
    return new Engine(opts, transport);
  }

  private freshSession(): SessionData {
    const systemContext = buildSessionContext({
      root: this.root,
      repoMap: buildRepoMap(this.index, this.config.context.repoMapTokens),
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
    // Keep the index fresh between turns; the repo map in the prompt stays frozen.
    this.lastIndexStats = this.index.update();
    const result = await this.agent.runTurn(this.session, text, emit, signal);
    if (this.persist && this.session.messages.length > 0) saveSession(this.root, this.session);
    return result;
  }
}
