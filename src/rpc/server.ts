import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Engine, type EngineOptions } from "../engine/engine.js";
import { listSessions, loadSession } from "../engine/session.js";
import { EFFORTS, PERMISSION_MODES, type Effort, type PermissionMode } from "../config/config.js";
import { MissingCredentialsError } from "../model/client.js";
import { readFileTool } from "../tools/fs-tools.js";
import pkg from "../../package.json" with { type: "json" };
import type { PermissionAnswer, PermissionRequest } from "../tools/permissions.js";

/**
 * JSON-RPC 2.0 over newline-delimited JSON on stdio.
 *
 * Client → server requests:
 *   initialize {cwd?, mode?, model?, effort?, resume?} → {root, files, model, mode, sessionId}
 *   chat/send {text}            → TurnResult (events stream as `chat/event` notifications)
 *   chat/cancel                 → {cancelled}
 *   chat/reset                  → {sessionId}
 *   context/search {query, limit?, pathFilter?} → SearchResult
 *   sessions/list               → SessionSummary[]
 *   shutdown                    → null
 * Server → client requests:
 *   permission/request {tool, access, description, preview?} → {answer: "allow" | "allow_always" | "deny"}
 */

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const ERR_PARSE = -32700;
const ERR_METHOD = -32601;
const ERR_INTERNAL = -32603;
const ERR_NOT_INITIALIZED = -32002;
const ERR_INVALID_PARAMS = -32602;
/** Raised by `initialize` when no API key is configured; clients can prompt for one and retry. */
export const ERR_MISSING_CREDENTIALS = -32001;

const invalid = (message: string) => Object.assign(new Error(message), { code: ERR_INVALID_PARAMS });

export class RpcServer {
  private engine: Engine | null = null;
  private initializing: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private nextId = 1;
  private pending = new Map<number, (msg: RpcMessage) => void>();
  private closed: Promise<void>;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly engineFactory: (opts: EngineOptions) => Engine | Promise<Engine> = Engine.open,
  ) {
    const rl = readline.createInterface({ input });
    rl.on("line", (line) => void this.onLine(line));
    this.closed = new Promise((resolve) => rl.on("close", () => resolve()));
  }

  /** Resolves when the input stream ends. */
  done(): Promise<void> {
    return this.closed;
  }

  private send(msg: RpcMessage): void {
    this.output.write(JSON.stringify(msg) + "\n");
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private request(method: string, params: Record<string, unknown>): Promise<RpcMessage> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private async onLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: ERR_PARSE, message: "Parse error" } });
      return;
    }
    // Response to a server → client request.
    if (!msg.method && typeof msg.id === "number" && this.pending.has(msg.id)) {
      this.pending.get(msg.id)!(msg);
      this.pending.delete(msg.id);
      return;
    }
    if (!msg.method) return;
    try {
      const result = await this.dispatch(msg.method, msg.params ?? {});
      if (msg.id !== undefined) this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
    } catch (err) {
      const e = err as Error & { code?: number };
      if (msg.id !== undefined) this.send({ jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? ERR_INTERNAL, message: e.message } });
    }
  }

  /** Waits for an in-flight `initialize`, so pipelined requests don't race it. */
  private async requireEngine(): Promise<Engine> {
    if (this.initializing) await this.initializing.catch(() => undefined);
    if (!this.engine) throw Object.assign(new Error("Call initialize first"), { code: ERR_NOT_INITIALIZED });
    return this.engine;
  }

  private async initialize(p: Record<string, unknown>) {
    await this.engine?.close();
    this.engine = null;
    try {
      this.engine = await this.engineFactory({
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        resume: typeof p.resume === "string" ? p.resume : undefined,
        overrides: {
          ...(typeof p.mode === "string" ? { permissionMode: p.mode as never } : {}),
          ...(typeof p.model === "string" ? { model: p.model } : {}),
          ...(typeof p.effort === "string" ? { effort: p.effort as never } : {}),
        },
        prompter: (req) => this.askPermission(req),
      });
    } catch (err) {
      if (err instanceof MissingCredentialsError) throw Object.assign(new Error(err.message), { code: ERR_MISSING_CREDENTIALS });
      throw err;
    }
    return this.describe(this.engine);
  }

  private describe(e: Engine) {
    return {
      version: pkg.version,
      root: e.root,
      files: e.index.fileCount,
      model: e.config.model,
      effort: e.config.effort,
      mode: e.gate.mode,
      sessionId: e.session.id,
      sources: e.index.sources(),
      mcp: e.mcpStatus,
      team: e.team ? { url: e.team.client.url, email: e.team.identity.email, groups: e.team.identity.groups, maxMode: e.team.policy.maxPermissionMode } : null,
    };
  }

  private async askPermission(req: PermissionRequest): Promise<PermissionAnswer> {
    const res = await this.request("permission/request", { ...req });
    const answer = (res.result as { answer?: string } | undefined)?.answer;
    return answer === "allow" || answer === "allow_always" ? answer : "deny";
  }

  private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const run = this.initialize(p);
        this.initializing = run;
        try {
          return await run;
        } finally {
          if (this.initializing === run) this.initializing = null;
        }
      }
      case "chat/setMode": {
        const e = await this.requireEngine();
        if (!PERMISSION_MODES.includes(p.mode as PermissionMode)) throw invalid(`mode must be one of ${PERMISSION_MODES.join(", ")}`);
        e.gate.mode = p.mode as PermissionMode;
        return { mode: e.gate.mode };
      }
      case "chat/setEffort": {
        const e = await this.requireEngine();
        if (!EFFORTS.includes(p.effort as Effort)) throw invalid(`effort must be one of ${EFFORTS.join(", ")}`);
        e.config.effort = p.effort as Effort;
        return { effort: e.config.effort };
      }
      case "chat/setModel": {
        const e = await this.requireEngine();
        if (typeof p.model !== "string" || !p.model.trim()) throw invalid("model is required");
        e.config.model = p.model;
        return { model: e.config.model };
      }
      case "context/read": {
        const e = await this.requireEngine();
        if (typeof p.path !== "string" || !p.path) throw invalid("path is required");
        const input = {
          path: p.path,
          ...(typeof p.start_line === "number" ? { start_line: p.start_line } : {}),
          ...(typeof p.end_line === "number" ? { end_line: p.end_line } : {}),
        };
        const out = await readFileTool.run(input, { root: e.root, config: e.config, index: e.index });
        const doc = p.path.startsWith("@") ? e.index.getExternalDoc(p.path) : null;
        return { content: out.content, ...(doc ? { title: doc.title, url: doc.url, source: doc.sourceLabel, text: doc.text } : {}) };
      }
      case "sources/list":
        return (await this.requireEngine()).index.sources();
      case "sessions/resume": {
        const e = await this.requireEngine();
        const s = typeof p.id === "string" ? loadSession(e.root, p.id) : null;
        if (!s) throw invalid(`Session not found: ${String(p.id)}`);
        e.session = s;
        return { sessionId: s.id, title: s.title, transcript: transcriptOf(s.messages) };
      }
      case "chat/send": {
        const e = await this.requireEngine();
        if (typeof p.text !== "string" || !p.text.trim()) throw Object.assign(new Error("text is required"), { code: -32602 });
        if (this.controller) throw new Error("A turn is already running; cancel it first");
        this.controller = new AbortController();
        try {
          return await e.send(p.text, (event) => this.notify("chat/event", { event }), this.controller.signal);
        } finally {
          this.controller = null;
        }
      }
      case "chat/cancel": {
        const running = !!this.controller;
        this.controller?.abort();
        return { cancelled: running };
      }
      case "chat/reset": {
        const e = await this.requireEngine();
        e.reset();
        return { sessionId: e.session.id };
      }
      case "context/search": {
        const e = await this.requireEngine();
        return e.index.search(String(p.query ?? ""), {
          limit: typeof p.limit === "number" ? p.limit : 10,
          scope: p.scope === "code" || p.scope === "docs" ? p.scope : "all",
          pathFilter: typeof p.pathFilter === "string" ? p.pathFilter : undefined,
        });
      }
      case "sessions/list":
        return listSessions((await this.requireEngine()).root);
      case "shutdown":
        this.controller?.abort();
        await this.engine?.close();
        setImmediate(() => this.input.destroy());
        return null;
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: ERR_METHOD });
    }
  }
}

/** User prompts and assistant replies as plain text, for re-rendering a resumed session. */
export function transcriptOf(messages: ReadonlyArray<{ role: string; content?: unknown }>): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of messages) {
    if (m.role === "user" && typeof m.content === "string") out.push({ role: "user", text: m.content });
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      if (text.trim()) out.push({ role: "assistant", text });
    }
  }
  return out;
}

export async function serveStdio(): Promise<void> {
  const server = new RpcServer(process.stdin, process.stdout);
  await server.done();
}
