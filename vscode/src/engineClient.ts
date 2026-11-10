import { fork, spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";

/** Error returned by the engine for a JSON-RPC request. */
export class RpcError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
  }
}

/** Matches the engine's code for "no API key configured". */
export const ERR_MISSING_CREDENTIALS = -32001;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface EngineClientOptions {
  /** Path to the bundled engine (`dist/server/codify.mjs`), run with the host's Node runtime. */
  serverPath?: string;
  /** An installed CLI to run instead, e.g. `codify`. Takes precedence over serverPath. */
  command?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

type RequestHandler = (params: Record<string, unknown>) => Promise<unknown>;

/**
 * Runs `codify serve --stdio` as a child process and speaks newline-delimited
 * JSON-RPC 2.0 with it. Handles server → client requests (permission prompts)
 * and notifications (streamed chat events).
 */
export class EngineClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notificationHandlers: Array<(method: string, params: Record<string, unknown>) => void> = [];
  private requestHandlers = new Map<string, RequestHandler>();
  private exitHandlers: Array<(code: number | null, expected: boolean) => void> = [];
  private stopping = false;

  constructor(private readonly opts: EngineClientOptions) {}

  get running(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  start(): void {
    if (this.running) return;
    this.stopping = false;
    const env = { ...process.env, ...this.opts.env, NO_COLOR: "1" };
    const args = ["serve", "--stdio"];
    if (this.opts.command) {
      this.child = spawn(this.opts.command, args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    } else if (this.opts.serverPath) {
      // fork() runs the module with the host's Node runtime (inside VS Code: Electron as Node).
      this.child = fork(this.opts.serverPath, args, { cwd: this.opts.cwd, env, stdio: ["pipe", "pipe", "pipe", "ipc"], execArgv: [] });
    } else {
      throw new Error("EngineClient needs serverPath or command");
    }
    const child = this.child;
    readline.createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr! }).on("line", (line) => this.opts.log?.(line));
    child.on("error", (err) => this.opts.log?.(`engine error: ${err.message}`));
    child.on("exit", (code) => {
      const expected = this.stopping;
      for (const p of this.pending.values()) p.reject(new RpcError(expected ? "Engine stopped" : `Engine exited (code ${code})`, -32000));
      this.pending.clear();
      if (this.child === child) this.child = null;
      for (const h of this.exitHandlers) h(code, expected);
    });
  }

  private write(msg: RpcMessage): void {
    this.child?.stdin?.write(JSON.stringify(msg) + "\n");
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.running) return Promise.reject(new RpcError("Engine is not running", -32000));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.notificationHandlers.push(handler);
  }

  /** Handle a request the engine sends to the client (e.g. `permission/request`). */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  onExit(handler: (code: number | null, expected: boolean) => void): void {
    this.exitHandlers.push(handler);
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      this.opts.log?.(`unparseable engine output: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.method && msg.id !== undefined && msg.id !== null) {
      void this.answer(msg.id, msg.method, msg.params ?? {});
      return;
    }
    if (msg.method) {
      for (const h of this.notificationHandlers) h(msg.method, msg.params ?? {});
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new RpcError(msg.error.message, msg.error.code));
      else p.resolve(msg.result);
    }
  }

  private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.requestHandlers.get(method);
    if (!handler) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Client does not handle ${method}` } });
      return;
    }
    try {
      this.write({ jsonrpc: "2.0", id, result: await handler(params) });
    } catch (err) {
      this.write({ jsonrpc: "2.0", id, error: { code: -32603, message: (err as Error).message } });
    }
  }

  /** Ask the engine to shut down, then make sure the process is gone. */
  async stop(): Promise<void> {
    if (!this.child) return;
    this.stopping = true;
    const child = this.child;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      await Promise.race([this.request("shutdown"), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      // already gone
    }
    const timer = setTimeout(() => child.kill(), 2000);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2500))]);
    clearTimeout(timer);
  }
}
