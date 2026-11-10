import { execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import pc from "picocolors";
import { loadConfig } from "../../config/config.js";
import { resolveCredentials } from "../../config/credentials.js";
import { ConnectorManager } from "../../connectors/manager.js";
import { ContextIndex, indexOptionsFor } from "../../context/index.js";
import { createDemoProject } from "../../demo/project.js";
import { DEMO_FOLLOW_UPS, DEMO_PROMPT, demoScript, ReplayTransport } from "../../demo/replay.js";
import { Engine } from "../../engine/engine.js";
import { terminalPrompter } from "../prompt.js";
import { banner, TerminalRenderer } from "../render.js";
import { runRepl } from "../repl.js";
import { runLogin } from "./login.js";

export interface DemoOptions {
  replay?: boolean;
  live?: boolean;
  force?: boolean;
  /** Replay without typing delays (CI, recordings). */
  fast?: boolean;
}

function hasCommand(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore", timeout: 5000, shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
}

const rule = () => pc.dim("─".repeat(Math.min(process.stdout.columns || 80, 80)));

/** `codify demo`: create a sample project and run the walkthrough, live or replayed. */
export async function runDemo(dirArg: string | undefined, o: DemoOptions): Promise<number> {
  const dir = path.resolve(dirArg ?? "codify-demo");
  const out = (s = "") => process.stdout.write(s + "\n");

  out(pc.bold(pc.magenta("◆ Codify Buddy demo")));
  out(pc.dim(`  Creating a sample project in ${dir}`));
  createDemoProject(dir, o.force);

  const config = loadConfig(dir);
  const index = new ContextIndex(dir, indexOptionsFor(dir, config));
  index.load();
  index.update();
  const manager = new ConnectorManager(config.connectors, { root: dir });
  for (const c of manager.connectors) await manager.sync(index, c.id);

  out();
  out(`  ${pc.bold("Acme Payments")}: a refunds service with a ledger, plus the team's context:`);
  out(`  ${pc.cyan("code")}        src/refunds.js, src/ledger.js, src/money.js and tests`);
  for (const s of index.sources()) out(`  ${pc.cyan(`@${s.id}`.padEnd(12))}${s.label} · ${s.docs} documents`);
  out(`  ${pc.cyan("memory")}      CODIFY.md team conventions`);
  out(pc.dim("  (The Confluence and GitHub sources are local snapshots so the demo works offline;"));
  out(pc.dim("   connect real ones with `codify connect confluence` / `codify connect github`.)"));
  out();

  const hasKey = resolveCredentials().source !== "none";
  const tty = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const live = o.live || (!o.replay && hasKey);

  if (live) {
    if (!hasKey && !(await runLogin())) return 1;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 100 });
    const engine = await Engine.open({ cwd: dir, prompter: terminalPrompter(() => rl) });
    out(banner(engine.root, engine.index.fileCount, engine.config.model, engine.gate.mode));
    out();
    out(pc.bold("  Suggested prompts") + pc.dim(" (the first one is pre-filled — press Enter)"));
    out(`  1. ${DEMO_PROMPT}`);
    DEMO_FOLLOW_UPS.forEach((p, i) => out(`  ${i + 2}. ${p}`));
    out();
    await runRepl(engine, rl, { initialInput: tty ? DEMO_PROMPT : undefined });
    await engine.close();
    return 0;
  }

  // Replay: the model's side is pre-recorded; every tool call runs for real.
  const canRunTests = hasCommand("npm");
  const transport = new ReplayTransport(demoScript({ canRunTests }), o.fast ? 0 : 6);
  const engine = await Engine.open({
    cwd: dir,
    transport,
    persist: false,
    overrides: { permissionMode: tty ? "ask" : "yolo", fallbacks: false },
    prompter: tty ? terminalPrompter(() => (rlReplay ??= readline.createInterface({ input: process.stdin, output: process.stdout }))) : undefined,
  });
  let rlReplay: readline.Interface | undefined;

  out(rule());
  out(pc.yellow("  ▶ Replay mode") + pc.dim(" — no API key found, so the model's messages are pre-recorded."));
  out(pc.dim("    Every tool call below (search, reads, edits, tests) runs for real against the demo project."));
  if (tty) out(pc.dim("    You'll be asked to approve the edit, exactly as in a live session."));
  if (!canRunTests) out(pc.yellow("    npm was not found, so the test steps are skipped."));
  out(rule());
  out();
  out(pc.magenta("› ") + DEMO_PROMPT);
  out();
  const res = await engine.send(DEMO_PROMPT, new TerminalRenderer().handle);
  rlReplay?.close();
  await engine.close();

  out();
  out(rule());
  out(pc.bold("  What just happened"));
  out("  • Searched code and connected docs together, and found the rule in the policy page, not just the code");
  out(
    canRunTests
      ? `  • Reproduced the bug with the real test suite, fixed it${tty ? " behind a permission prompt" : " (auto-approved: no terminal attached)"}, and re-ran the tests`
      : `  • Fixed the bug${tty ? " behind a permission prompt" : " (auto-approved: no terminal attached)"}`,
  );
  out("  • Cited every claim, and flagged a stale doc (60-day code vs 30-day policy) nobody asked about");
  out();
  out(pc.bold("  Try it yourself"));
  out(`  cd ${path.relative(process.cwd(), dir) || "."} && git diff        ${pc.dim("# the change it made")}`);
  out(`  codify search "refund window"           ${pc.dim("# offline search, no model needed")}`);
  out(`  codify login && codify demo --live --force   ${pc.dim("# run the same demo live")}`);
  out(rule());
  return res.stopReason === "end_turn" ? 0 : 1;
}
