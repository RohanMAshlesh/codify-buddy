import * as vscode from "vscode";
import type { FromWebview, ToWebview } from "./protocol.js";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

const SUGGESTIONS = [
  "How is this project structured? Cite the key files.",
  "Find where errors are handled and summarise the approach.",
  "What do our docs say about this area, and does the code match?",
];

/** The sidebar chat. Messages it can't handle itself go to `onMessage`. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "codify.chat";
  private view: vscode.WebviewView | null = null;
  private queue: ToWebview[] = [];
  private ready = false;

  constructor(private readonly extensionUri: vscode.Uri, private readonly onMessage: (m: FromWebview) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    const webviewRoot = vscode.Uri.joinPath(this.extensionUri, "dist", "webview");
    view.webview.options = { enableScripts: true, localResourceRoots: [webviewRoot] };
    view.webview.html = this.html(view.webview, webviewRoot);
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === "ready") {
        this.ready = true;
        for (const q of this.queue.splice(0)) void view.webview.postMessage(q);
      }
      this.onMessage(m);
    });
    view.onDidDispose(() => {
      this.view = null;
      this.ready = false;
    });
  }

  /** Post to the webview, buffering until it has loaded. */
  post(m: ToWebview): void {
    if (this.view && this.ready) void this.view.webview.postMessage(m);
    else this.queue.push(m);
  }

  get visible(): boolean {
    return !!this.view?.visible;
  }

  async reveal(): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const n = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(root, "chat.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(root, "chat.css"));
    const csp = [`default-src 'none'`, `style-src ${webview.cspSource}`, `script-src 'nonce-${n}'`, `img-src ${webview.cspSource} data:`].join("; ");
    const suggestions = SUGGESTIONS.map((s) => `<button class="secondary" data-prompt="${s.replace(/"/g, "&quot;")}">${s}</button>`).join("");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${style}">
<title>Codify Buddy</title>
</head>
<body>
<div id="status">Starting…</div>
<div id="log">
  <div id="empty">
    <h3>Ask about your code and your team's docs</h3>
    Answers cite files and documents you can click. Edits wait for your approval.
    ${suggestions}
  </div>
</div>
<div id="composer">
  <textarea id="input" rows="1" aria-label="Message"></textarea>
  <button id="send" title="Send (Enter)">Send</button>
  <button id="stop" class="secondary" title="Stop" hidden>Stop</button>
</div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }
}
