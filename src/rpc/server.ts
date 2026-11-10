import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Engine, type EngineOptions } from "../engine/engine.js";
import { listSessions } from "../engine/session.js";
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

export class RpcServer {
  private engine: Engine | null = null;
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

  private requireEngine(): Engine {
    if (!this.engine) throw Object.assign(new Error("Call initialize first"), { code: ERR_NOT_INITIALIZED });
    return this.engine;
  }

  private async askPermission(req: PermissionRequest): Promise<PermissionAnswer> {
    const res = await this.request("permission/request", { ...req });
    const answer = (res.result as { answer?: string } | undefined)?.answer;
    return answer === "allow" || answer === "allow_always" ? answer : "deny";
  }

  private async dispatch(method: string, p: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        await this.engine?.close();
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
        const e = this.engine;
        return { root: e.root, files: e.index.fileCount, model: e.config.model, mode: e.gate.mode, sessionId: e.session.id };
      }
      case "chat/send": {
        const e = this.requireEngine();
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
        const e = this.requireEngine();
        e.reset();
        return { sessionId: e.session.id };
      }
      case "context/search": {
        const e = this.requireEngine();
        return e.index.search(String(p.query ?? ""), {
          limit: typeof p.limit === "number" ? p.limit : 10,
          pathFilter: typeof p.pathFilter === "string" ? p.pathFilter : undefined,
        });
      }
      case "sessions/list":
        return listSessions(this.requireEngine().root);
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

export async function serveStdio(): Promise<void> {
  const server = new RpcServer(process.stdin, process.stdout);
  await server.done();
}
