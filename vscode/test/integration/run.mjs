// Launches a real VS Code with the extension and runs suite.cjs inside it.
// Needs network (downloads VS Code) and, on Linux, a display: `xvfb-run -a npm run test:integration`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTests } from "@vscode/test-electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "codify-it-"));
fs.mkdirSync(path.join(workspace, ".git"));
fs.mkdirSync(path.join(workspace, "src"));
fs.writeFileSync(path.join(workspace, "src", "refund.ts"), "export function refundAmount(c: number) {\n  return Math.floor(c / 2);\n}\n");

try {
  await runTests({
    extensionDevelopmentPath: path.resolve(here, "../.."),
    extensionTestsPath: path.resolve(here, "suite.cjs"),
    launchArgs: [workspace, "--disable-extensions", "--disable-workspace-trust"],
    extensionTestsEnv: {
      CODIFY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "codify-it-home-")),
      ANTHROPIC_API_KEY: "sk-ant-integration-test",
    },
  });
} catch (err) {
  console.error("Integration tests failed:", err);
  process.exit(1);
}
