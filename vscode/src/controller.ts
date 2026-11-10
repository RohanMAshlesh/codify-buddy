import * as vscode from "vscode";
import type { ChatViewProvider } from "./chatView.js";
import { EngineClient, ERR_MISSING_CREDENTIALS, RpcError } from "./engineClient.js";
import type { EngineEvent, EngineInfo, FromWebview } from "./protocol.js";
import { parseCitation } from "./webview/render.js";

export const API_KEY_SECRET = "codify.anthropicApiKey";
const MODES = [
  { label: "ask", detail: "Reads run automatically; every edit and command asks first (recommended)" },
  { label: "auto-edit", detail: "Edits apply automatically; commands still ask" },
  { label: "read-only", detail: "No edits or commands" },
  { label: "yolo", detail: "Everything runs without asking" },
];

interface ProposedChange {
  path: string;
  before: string;
  after: string;
  isNew: boolean;
}

interface PendingPermission {
  resolve: (answer: string) => void;
  change?: ProposedChange;
}

/** In-memory documents for proposed edits and connected docs (read-only virtual files). */
export class MemoryDocuments implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();
  private emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  set(uri: vscode.Uri, text: string): void {
    this.docs.set(uri.toString(), text);
    this.emitter.fire(uri);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.toString()) ?? "";
  }
}

/** Owns the engine process and everything that talks to it. */
export class Controller implements vscode.Disposable {
  private client: EngineClient | null = null;
  private info: EngineInfo | null = null;
  private starting: Promise<void> | null = null;
  private busy = false;
  private nextPermission = 1;
  private permissions = new Map<number, PendingPermission>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly view: ChatViewProvider,
    private readonly docs: MemoryDocuments,
    private readonly status: vscode.StatusBarItem,
    private readonly output: vscode.OutputChannel,
  ) {}

  get root(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  /** Start the engine if it isn't running. Safe to call repeatedly. */
  ensureStarted(): Promise<void> {
    if (this.client?.running && this.info) return Promise.resolve();
    this.starting ??= this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<void> {
    const root = this.root;
    if (!root || root.scheme !== "file") {
      this.view.post({ type: "state", status: "noWorkspace" });
      this.setStatus("$(folder) Codify: open a folder", "Open a folder to use Codify Buddy");
      return;
    }
    this.view.post({ type: "state", status: "starting" });
    this.setStatus("$(loading~spin) Codify", "Starting the engine");

    const cfg = vscode.workspace.getConfiguration("codify");
    const key = await this.context.secrets.get(API_KEY_SECRET);
    const command = cfg.get<string>("serverCommand")?.trim();
    const client = new EngineClient({
      cwd: root.fsPath,
      command: command || undefined,
      serverPath: vscode.Uri.joinPath(this.context.extensionUri, "dist", "server", "codify.mjs").fsPath,
      env: key ? { ANTHROPIC_API_KEY: key } : {},
      log: (line) => this.output.appendLine(line),
    });
    client.onNotification((method, params) => {
      if (method === "chat/event") this.view.post({ type: "event", event: params.event as EngineEvent });
    });
    client.onRequest("permission/request", (params) => this.askPermission(params));
    client.onExit((code, expected) => {
      this.output.appendLine(`engine exited (code ${code})`);
      if (this.client !== client) return;
      this.client = null;
      this.info = null;
      this.setBusy(false);
      this.denyAllPending();
      if (!expected) {
        this.view.post({ type: "state", status: "error", message: `The engine stopped unexpectedly (code ${code}). See "Codify: Show Engine Log".` });
        this.setStatus("$(error) Codify", "Engine stopped — click to restart", "codify.restartEngine");
      }
    });
    this.client = client;
    try {
      client.start();
      const effort = cfg.get<string>("effort");
      const model = cfg.get<string>("model");
      this.info = await client.request<EngineInfo>("initialize", {
        cwd: root.fsPath,
        mode: cfg.get<string>("permissionMode") ?? "ask",
        ...(effort ? { effort } : {}),
        ...(model ? { model } : {}),
      });
      this.view.post({ type: "state", status: "ready", info: this.info });
      this.updateStatus();
      for (const m of this.info.mcp) if (!m.ok) this.view.post({ type: "notice", level: "warn", message: `MCP server "${m.name}" unavailable: ${m.error ?? "unknown error"}` });
    } catch (err) {
      this.info = null;
      if (err instanceof RpcError && err.code === ERR_MISSING_CREDENTIALS) {
        this.view.post({ type: "state", status: "needsKey" });
        this.setStatus("$(key) Codify: add API key", "Set your Anthropic API key", "codify.setApiKey");
      } else {
        this.view.post({ type: "state", status: "error", message: (err as Error).message });
        this.setStatus("$(error) Codify", (err as Error).message, "codify.restartEngine");
      }
      await client.stop();
      if (this.client === client) this.client = null;
    }
  }

  async restart(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.info = null;
    this.denyAllPending();
    await c?.stop();
    await this.ensureStarted();
  }

  private setStatus(text: string, tooltip: string, command = "codify.setMode"): void {
    this.status.text = text;
    this.status.tooltip = tooltip;
    this.status.command = command;
    this.status.show();
  }

  private updateStatus(): void {
    if (!this.info) return;
    if (this.busy) this.setStatus("$(loading~spin) Codify", "Working…", "codify.stop");
    else this.setStatus(`$(code) Codify: ${this.info.mode}`, `Permission mode: ${this.info.mode} — click to change`);
  }

  private setBusy(b: boolean): void {
    this.busy = b;
    this.view.post({ type: "busy", busy: b });
    this.updateStatus();
  }

  /** Send a message as if typed in the chat. `contextLabel` shows as a chip (e.g. the selection). */
  async send(text: string, contextLabel?: string): Promise<void> {
    await this.view.reveal();
    await this.ensureStarted();
    if (!this.client || !this.info) return;
    if (this.busy) {
      void vscode.window.showInformationMessage("Codify is still working on the previous message.");
      return;
    }
    this.view.post({ type: "user", text: contextLabel ? text.split("\n\nSelected code from")[0]! : text, context: contextLabel });
    this.setBusy(true);
    try {
      await this.client.request("chat/send", { text });
    } catch (err) {
      this.view.post({ type: "notice", level: "error", message: (err as Error).message });
    } finally {
      this.setBusy(false);
    }
  }

  async stop(): Promise<void> {
    this.denyAllPending();
    await this.client?.request("chat/cancel").catch(() => undefined);
  }

  async newChat(): Promise<void> {
    await this.ensureStarted();
    if (this.busy) await this.stop();
    await this.client?.request("chat/reset").catch(() => undefined);
    this.view.post({ type: "reset" });
  }

  private async askPermission(params: Record<string, unknown>): Promise<{ answer: string }> {
    const id = this.nextPermission++;
    const change = params.change as ProposedChange | undefined;
    const answer = new Promise<string>((resolve) => this.permissions.set(id, { resolve, change }));
    this.view.post({
      type: "permission",
      id,
      access: String(params.access ?? ""),
      tool: String(params.tool ?? ""),
      description: String(params.description ?? ""),
      preview: typeof params.preview === "string" ? params.preview : undefined,
      hasChange: !!change,
    });
    await this.view.reveal();
    if (change && vscode.workspace.getConfiguration("codify").get<boolean>("openDiffOnApproval", true)) void this.openDiff(id);
    return { answer: await answer };
  }

  answer(id: number, answer: string): void {
    const p = this.permissions.get(id);
    if (!p) return;
    this.permissions.delete(id);
    p.resolve(answer);
    this.view.post({ type: "permissionDone", id, answer });
  }

  private denyAllPending(): void {
    for (const id of [...this.permissions.keys()]) this.answer(id, "deny");
  }

  /** Show a pending edit in VS Code's diff editor. */
  async openDiff(id: number): Promise<void> {
    const change = this.permissions.get(id)?.change;
    const root = this.root;
    if (!change || !root) return;
    const right = vscode.Uri.from({ scheme: "codify-proposed", path: `/${id}/${change.path}` });
    this.docs.set(right, change.after);
    let left: vscode.Uri;
    if (change.isNew) {
      left = vscode.Uri.from({ scheme: "codify-proposed", path: `/${id}/empty/${change.path}` });
      this.docs.set(left, "");
    } else {
      // Snapshot the current file, so the diff matches what the agent proposed against.
      left = vscode.Uri.from({ scheme: "codify-proposed", path: `/${id}/before/${change.path}` });
      this.docs.set(left, change.before);
    }
    await vscode.commands.executeCommand("vscode.diff", left, right, `${change.path} (proposed by Codify)`, { preview: true, preserveFocus: true });
  }

  /** Open a citation: a project file at a line range, or a connected document. */
  async openCitation(target: string): Promise<void> {
    const c = parseCitation(target);
    const root = this.root;
    if (!c || !root) return;
    const range = (doc: vscode.TextDocument, offset = 0) => {
      if (!c.startLine) return undefined;
      const start = Math.min(Math.max(c.startLine - 1 + offset, 0), doc.lineCount - 1);
      const end = Math.min(Math.max((c.endLine ?? c.startLine) - 1 + offset, start), doc.lineCount - 1);
      return new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
    };
    try {
      if (c.path.startsWith("@")) {
        await this.ensureStarted();
        const res = await this.client!.request<{ title?: string; url?: string; source?: string; text?: string }>("context/read", { path: c.path });
        const header = `<!-- ${res.title ?? c.path} · ${res.source ?? ""}${res.url ? ` · ${res.url}` : ""} -->\n`;
        const uri = vscode.Uri.from({ scheme: "codify-doc", path: `/${c.path.slice(1)}.md` });
        this.docs.set(uri, header + (res.text ?? ""));
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(doc, "markdown");
        await vscode.window.showTextDocument(doc, { selection: range(doc, 1), preview: true });
        if (res.url && /^https?:/.test(res.url)) {
          const pick = await vscode.window.showInformationMessage(`${res.title ?? c.path} (${res.source ?? "connected source"})`, "Open in browser");
          if (pick) void vscode.env.openExternal(vscode.Uri.parse(res.url));
        }
        return;
      }
      const uri = vscode.Uri.joinPath(root, ...c.path.split("/"));
      const doc = await vscode.workspace.openTextDocument(uri);
      const selection = range(doc);
      await vscode.window.showTextDocument(doc, { selection, preview: true });
    } catch (err) {
      void vscode.window.showWarningMessage(`Couldn't open ${target}: ${(err as Error).message}`);
    }
  }

  async pickMode(): Promise<void> {
    await this.ensureStarted();
    if (!this.client || !this.info) return;
    const pick = await vscode.window.showQuickPick(
      MODES.map((m) => ({ ...m, description: m.label === this.info!.mode ? "current" : undefined })),
      { title: "Codify: permission mode for this session" },
    );
    if (!pick) return;
    const res = await this.client.request<{ mode: string }>("chat/setMode", { mode: pick.label });
    this.info = { ...this.info, mode: res.mode };
    this.view.post({ type: "state", status: "ready", info: this.info });
    this.updateStatus();
  }

  async searchContext(): Promise<void> {
    await this.ensureStarted();
    const client = this.client;
    if (!client || !this.info) return;
    type Item = vscode.QuickPickItem & { target?: string };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = "Codify: search code and connected docs";
    qp.placeholder = "e.g. refund rounding, UserService.findById, deploy runbook";
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    let timer: NodeJS.Timeout | undefined;
    qp.onDidChangeValue((value) => {
      if (timer) clearTimeout(timer);
      if (!value.trim()) {
        qp.items = [];
        return;
      }
      timer = setTimeout(async () => {
        qp.busy = true;
        try {
          const res = await client.request<{ hits: Array<{ citation: string; symbol?: string; title?: string; kind: string; source?: string; text?: string }> }>("context/search", { query: value, limit: 20 });
          qp.items = res.hits.map((h) => ({
            label: `${h.source ? "$(book)" : "$(symbol-method)"} ${h.title ?? h.symbol ?? h.citation.split(":")[0]}`,
            description: h.citation,
            detail: (h.text ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 160),
            target: h.citation,
            alwaysShow: true,
          }));
        } finally {
          qp.busy = false;
        }
      }, 150);
    });
    qp.onDidAccept(() => {
      const target = qp.selectedItems[0]?.target;
      qp.hide();
      if (target) void this.openCitation(target);
    });
    qp.onDidHide(() => qp.dispose());
    qp.show();
  }

  async resumeSession(): Promise<void> {
    await this.ensureStarted();
    const client = this.client;
    if (!client || !this.info) return;
    const sessions = await client.request<Array<{ id: string; title: string; updatedAt: string; turns: number }>>("sessions/list");
    if (!sessions.length) {
      void vscode.window.showInformationMessage("No saved sessions for this project yet.");
      return;
    }
    const pick = await vscode.window.showQuickPick(
      sessions.map((s) => ({ label: s.title || "(untitled)", description: `${s.updatedAt.slice(0, 16).replace("T", " ")} · ${s.turns} turns`, id: s.id })),
      { title: "Codify: resume a session" },
    );
    if (!pick) return;
    const res = await client.request<{ title: string; transcript: Array<{ role: "user" | "assistant"; text: string }> }>("sessions/resume", { id: pick.id });
    await this.view.reveal();
    this.view.post({ type: "transcript", title: res.title, items: res.transcript });
  }

  async setApiKey(): Promise<void> {
    const key = await vscode.window.showInputBox({
      title: "Anthropic API key",
      prompt: "Stored in VS Code's secret storage and passed only to the Codify engine. Create one at console.anthropic.com.",
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim().length < 10 ? "That doesn't look like an API key" : undefined),
    });
    if (!key) return;
    await this.context.secrets.store(API_KEY_SECRET, key.trim());
    await this.restart();
  }

  /** Route messages from the webview. */
  handle(m: FromWebview): void {
    switch (m.type) {
      case "ready":
        if (this.info) this.view.post({ type: "state", status: "ready", info: this.info });
        void this.ensureStarted();
        break;
      case "send":
        void this.send(m.text);
        break;
      case "stop":
        void this.stop();
        break;
      case "answer":
        this.answer(m.id, m.answer);
        break;
      case "openDiff":
        void this.openDiff(m.id);
        break;
      case "openCite":
        void this.openCitation(m.target);
        break;
      case "openUrl":
        if (/^https?:\/\//.test(m.url)) void vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case "command":
        void vscode.commands.executeCommand(`codify.${m.command}`);
        break;
    }
  }

  dispose(): void {
    this.denyAllPending();
    void this.client?.stop();
    this.client = null;
  }
}
