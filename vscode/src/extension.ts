import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView.js";
import { Controller, MemoryDocuments } from "./controller.js";

/** Build the prompt for a question about the current selection. */
export function selectionPrompt(question: string, rel: string, start: number, end: number, languageId: string, code: string): string {
  return `${question}\n\nSelected code from \`${rel}:${start}-${end}\`:\n\`\`\`${languageId}\n${code}\n\`\`\``;
}

function currentSelection(): { rel: string; start: number; end: number; languageId: string; code: string } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select some code first.");
    return null;
  }
  const sel = editor.selection;
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line - 1 : sel.end.line;
  return {
    rel: vscode.workspace.asRelativePath(editor.document.uri, false),
    start: sel.start.line + 1,
    end: end + 1,
    languageId: editor.document.languageId,
    code: editor.document.getText(sel),
  };
}

export function activate(context: vscode.ExtensionContext): { controller: Controller } {
  const output = vscode.window.createOutputChannel("Codify Buddy");
  const docs = new MemoryDocuments();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(code) Codify";
  status.command = "codify.newChat";
  status.show();

  let controller: Controller;
  const view = new ChatViewProvider(context.extensionUri, (m) => controller.handle(m));
  controller = new Controller(context, view, docs, status, output);

  const cmd = (id: string, fn: () => unknown) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    output,
    status,
    controller,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, view, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider("codify-proposed", docs),
    vscode.workspace.registerTextDocumentContentProvider("codify-doc", docs),
    cmd("codify.newChat", () => controller.newChat()),
    cmd("codify.askSelection", async () => {
      const s = currentSelection();
      if (!s) return;
      const question = await vscode.window.showInputBox({ title: `Ask Codify about ${s.rel}:${s.start}-${s.end}`, placeHolder: "What do you want to know or change?" });
      if (!question) return;
      await controller.send(selectionPrompt(question, s.rel, s.start, s.end, s.languageId, s.code), `${s.rel}:${s.start}-${s.end}`);
    }),
    cmd("codify.explainSelection", async () => {
      const s = currentSelection();
      if (!s) return;
      const q = "Explain what this code does and why, using the surrounding code and our docs. Cite sources.";
      await controller.send(selectionPrompt(q, s.rel, s.start, s.end, s.languageId, s.code), `${s.rel}:${s.start}-${s.end}`);
    }),
    cmd("codify.searchContext", () => controller.searchContext()),
    cmd("codify.setMode", () => controller.pickMode()),
    cmd("codify.resumeSession", () => controller.resumeSession()),
    cmd("codify.stop", () => controller.stop()),
    cmd("codify.setApiKey", () => controller.setApiKey()),
    cmd("codify.restartEngine", () => controller.restart()),
    cmd("codify.showLog", () => output.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codify.serverCommand") || e.affectsConfiguration("codify.model") || e.affectsConfiguration("codify.effort") || e.affectsConfiguration("codify.permissionMode")) {
        void vscode.window.showInformationMessage("Codify settings changed. Restart the engine to apply them?", "Restart").then((pick) => {
          if (pick) void controller.restart();
        });
      }
    }),
  );
  return { controller };
}

export function deactivate(): void {
  // Disposables registered in activate() stop the engine.
}
