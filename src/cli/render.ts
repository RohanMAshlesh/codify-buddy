import pc from "picocolors";
import type { EngineEvent } from "../engine/events.js";
import type { Usage } from "../model/pricing.js";

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export function formatUsage(u: Usage, cost: number | null): string {
  const parts = [
    `in ${formatTokens(u.inputTokens)}`,
    `cached ${formatTokens(u.cacheReadTokens)}`,
    `out ${formatTokens(u.outputTokens)}`,
  ];
  if (cost !== null) parts.push(`~$${cost.toFixed(cost < 0.1 ? 4 : 2)}`);
  return parts.join(" · ");
}

export function colorDiff(diff: string, maxLines = 40, indent = "    "): string {
  const lines = diff.split("\n");
  const shown = lines.slice(0, maxLines).map((l) =>
    l.startsWith("+") ? pc.green(l) : l.startsWith("-") ? pc.red(l) : l.startsWith("@@") ? pc.cyan(l) : pc.dim(l),
  );
  if (lines.length > maxLines) shown.push(pc.dim(`… ${lines.length - maxLines} more diff lines`));
  return shown.map((l) => indent + l).join("\n");
}

export interface RendererOptions {
  showThinking?: boolean;
  out?: NodeJS.WritableStream;
}

/** Renders engine events to a terminal as they stream. */
export class TerminalRenderer {
  private atLineStart = true;
  private inThinking = false;
  private readonly out: NodeJS.WritableStream;
  lastUsage: { session: Usage; cost: number | null } | null = null;

  constructor(private readonly opts: RendererOptions = {}) {
    this.out = opts.out ?? process.stdout;
  }

  private write(s: string) {
    if (!s) return;
    this.out.write(s);
    this.atLineStart = s.endsWith("\n");
  }

  private newline() {
    if (!this.atLineStart) this.write("\n");
  }

  handle = (ev: EngineEvent): void => {
    switch (ev.type) {
      case "turn_start":
        break;
      case "thinking":
        if (!this.inThinking) {
          this.newline();
          this.write(pc.dim(pc.italic("∴ thinking…")) + (this.opts.showThinking ? "\n" : ""));
          this.inThinking = true;
        }
        if (this.opts.showThinking) this.write(pc.dim(ev.text));
        break;
      case "text":
        if (this.inThinking) {
          this.write("\n");
          this.inThinking = false;
        }
        this.write(ev.text);
        break;
      case "tool_call":
        this.inThinking = false;
        this.newline();
        this.write(pc.cyan("● ") + pc.bold(ev.name) + pc.dim(` ${ev.description}`) + "\n");
        break;
      case "tool_result":
        this.write((ev.ok ? pc.green("  ⎿ ") : pc.red("  ⎿ ")) + pc.dim(ev.summary) + "\n");
        if (ev.diff) this.write(colorDiff(ev.diff) + "\n");
        break;
      case "usage":
        this.lastUsage = { session: ev.session, cost: ev.costUsd };
        break;
      case "notice": {
        this.newline();
        const color = ev.level === "error" ? pc.red : ev.level === "warn" ? pc.yellow : pc.dim;
        this.write(color(`${ev.level === "error" ? "✖" : "!"} ${ev.message}`) + "\n");
        break;
      }
      case "turn_end":
        this.inThinking = false;
        this.newline();
        if (this.lastUsage) this.write(pc.dim(formatUsage(this.lastUsage.session, this.lastUsage.cost)) + "\n");
        break;
    }
  };
}

export function banner(root: string, files: number, model: string, mode: string): string {
  return [
    pc.bold(pc.magenta("◆ Codify Buddy")) + pc.dim("  your AI coding copilot"),
    pc.dim(`  project ${root}`),
    pc.dim(`  indexed ${files} files · model ${model} · mode ${mode}`),
    pc.dim("  /help for commands · Ctrl+C to interrupt · /exit to quit"),
  ].join("\n");
}
