// Runs inside VS Code's extension host.
const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const ext = vscode.extensions.getExtension("rohanmashlesh.codify-buddy-vscode");
  assert.ok(ext, "extension is installed");
  const { controller } = await ext.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const id of ["codify.newChat", "codify.askSelection", "codify.explainSelection", "codify.searchContext", "codify.setMode", "codify.resumeSession", "codify.setApiKey", "codify.restartEngine"]) {
    assert.ok(commands.includes(id), `command ${id} is registered`);
  }

  // The bundled engine starts with the Electron runtime and indexes the workspace.
  await controller.ensureStarted();
  assert.equal(controller.info?.files, 1, "engine indexed the workspace");
  assert.equal(controller.info?.mode, "ask");

  // Citations open the file at the cited line.
  await controller.openCitation("src/refund.ts:2");
  const editor = vscode.window.activeTextEditor;
  assert.ok(editor, "an editor opened");
  assert.equal(path.basename(editor.document.uri.fsPath), "refund.ts");
  assert.equal(editor.selection.start.line, 1);

  // The chat view resolves.
  await vscode.commands.executeCommand("codify.chat.focus");
  await wait(500);

  controller.dispose();
  console.log("Codify Buddy integration tests passed");
}

module.exports = { run };
