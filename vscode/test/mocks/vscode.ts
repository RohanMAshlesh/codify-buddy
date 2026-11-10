// Minimal stand-in for the VS Code API surface the extension's controller uses.
// Every UI call is recorded so tests can assert on it and script answers.
import fs from "node:fs";
import nodePath from "node:path";

export const calls: Array<{ fn: string; args: unknown[] }> = [];
const record = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
export const answers: { inputBox?: string; quickPick?: (items: any[]) => any; info?: string } = {};

export class Uri {
  private constructor(readonly scheme: string, readonly path: string) {}
  static file(p: string) {
    return new Uri("file", p);
  }
  static from(c: { scheme: string; path: string }) {
    return new Uri(c.scheme, c.path);
  }
  static parse(s: string) {
    const i = s.indexOf(":");
    return new Uri(s.slice(0, i), s.slice(i + 1));
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(base.scheme, nodePath.join(base.path, ...parts));
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    return `${this.scheme}:${this.path}`;
  }
}

export class Range {
  constructor(readonly startLine: number, readonly startChar: number, readonly endLine: number, readonly endChar: number) {}
}

export class EventEmitter<T> {
  private handlers: Array<(e: T) => void> = [];
  event = (h: (e: T) => void) => {
    this.handlers.push(h);
    return { dispose() {} };
  };
  fire(e: T) {
    for (const h of this.handlers) h(e);
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

const config: Record<string, unknown> = { permissionMode: "ask", openDiffOnApproval: true };
export const setConfig = (k: string, v: unknown) => (config[k] = v);

const providers = new Map<string, { provideTextDocumentContent(uri: Uri): string }>();

export const workspace = {
  workspaceFolders: [] as Array<{ uri: Uri }>,
  registerTextDocumentContentProvider(scheme: string, provider: { provideTextDocumentContent(uri: Uri): string }) {
    providers.set(scheme, provider);
    return { dispose: () => providers.delete(scheme) };
  },
  getConfiguration: () => ({ get: <T>(k: string, d?: T) => (k in config ? (config[k] as T) : d) }),
  async openTextDocument(uri: Uri) {
    record("openTextDocument", uri.toString());
    const text = uri.scheme === "file" ? fs.readFileSync(uri.fsPath, "utf8") : (providers.get(uri.scheme)?.provideTextDocumentContent(uri) ?? "");
    const lines = text.split("\n");
    return { uri, lineCount: lines.length, lineAt: (i: number) => ({ text: lines[i] ?? "" }) };
  },
  asRelativePath: (uri: Uri) => uri.path,
};

export const window = {
  async showInformationMessage(msg: string, ...items: string[]) {
    record("showInformationMessage", msg, ...items);
    return answers.info;
  },
  async showWarningMessage(msg: string) {
    record("showWarningMessage", msg);
    return undefined;
  },
  async showInputBox(opts: unknown) {
    record("showInputBox", opts);
    return answers.inputBox;
  },
  async showQuickPick(items: any[]) {
    record("showQuickPick", items);
    return answers.quickPick?.(items);
  },
  async showTextDocument(doc: { uri: Uri }, opts: unknown) {
    record("showTextDocument", doc.uri.toString(), opts);
  },
  createQuickPick() {
    throw new Error("not mocked");
  },
};

export const commands = {
  async executeCommand(id: string, ...args: unknown[]) {
    record("executeCommand", id, ...args.map((a) => (a instanceof Uri ? a.toString() : a)));
  },
};

export const languages = {
  async setTextDocumentLanguage(doc: unknown, lang: string) {
    record("setTextDocumentLanguage", lang);
    return doc;
  },
};

export const env = {
  async openExternal(uri: Uri) {
    record("openExternal", uri.toString());
    return true;
  },
};
