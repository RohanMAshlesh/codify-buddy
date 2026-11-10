import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTransport, StreamHandlers, StreamParams } from "../model/transport.js";
import { DEMO_FILES, lineOf } from "./project.js";

type Block = Record<string, unknown>;

interface Step {
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Replays a recorded model session for `codify demo` when no API key is
 * available. Only the model's messages are scripted: every tool call they
 * request is executed for real by the engine against the demo project.
 */
export class ReplayTransport implements ModelTransport {
  private step = 0;

  constructor(private readonly steps: Step[], private readonly charDelayMs = 6) {}

  get done(): boolean {
    return this.step >= this.steps.length;
  }

  async stream(_params: StreamParams, handlers: StreamHandlers, signal?: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
    const s = this.steps[this.step++];
    if (!s) throw new Error("The demo replay has finished. Run `codify demo` with an API key to keep chatting live.");
    handlers.onThinking?.("…");
    await sleep(this.charDelayMs * 60);
    const content: Block[] = [];
    if (s.text) {
      for (const word of s.text.split(/(?<=\s)/)) {
        if (signal?.aborted) break;
        handlers.onText?.(word);
        if (this.charDelayMs) await sleep(this.charDelayMs * Math.min(word.length, 8));
      }
      content.push({ type: "text", text: s.text });
    }
    if (s.tool) content.push({ type: "tool_use", id: `toolu_demo_${this.step}`, name: s.tool.name, input: s.tool.input });
    return {
      id: `msg_demo_${this.step}`,
      type: "message",
      role: "assistant",
      model: "replay",
      content,
      stop_reason: s.tool ? "tool_use" : "end_turn",
      stop_details: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    } as unknown as Anthropic.Beta.BetaMessage;
  }
}

export const DEMO_PROMPT =
  "Issue #42 says a customer was refunded $4.99 instead of $5.00. Find the root cause using our refund policy, fix it, and run the tests.";

export const DEMO_FOLLOW_UPS = [
  "Is our Refund Policy page up to date with the code? Cite both.",
  "Explain how a refund flows from calculation to the ledger, with citations.",
  "Draft the Confluence update for the Refund Policy based on issue #51.",
];

/** The recorded session for DEMO_PROMPT. Citations are computed from the demo files. */
export function demoScript(opts: { canRunTests: boolean }): Step[] {
  const code = DEMO_FILES["src/refunds.js"]!;
  const policy = DEMO_FILES["wiki/refund-policy.md"]!;
  const floorLine = lineOf(code, "Math.floor(");
  const windowLine = lineOf(code, "REFUND_WINDOW_DAYS = 60");
  const roundingStart = lineOf(policy, "## 2. Partial refunds");
  const roundingEnd = lineOf(policy, "reconciliation with the card processor");
  const eligibilityLine = lineOf(policy, "within **30 days**");

  const steps: Step[] = [
    {
      text: "I'll start by finding the refund calculation and anything the team has written about refund rounding.",
      tool: { name: "search_context", input: { query: "partial refund rounding cents" } },
    },
    { text: "The policy and the calculation both came up. Let me read the code first.", tool: { name: "read_file", input: { path: "src/refunds.js" } } },
    { text: "Now the exact policy wording.", tool: { name: "read_file", input: { path: "@confluence/refund-policy" } } },
  ];
  if (opts.canRunTests) {
    steps.push({ text: "The policy requires rounding half up, but the code uses `Math.floor`. Let me confirm with the test suite.", tool: { name: "run_command", input: { command: "npm test" } } });
  }
  steps.push({
    text: `${opts.canRunTests ? "Confirmed: the half-cent test fails with 499 instead of 500." : "The code rounds down, which contradicts the policy."} Fixing the rounding:`,
    tool: {
      name: "edit_file",
      input: {
        path: "src/refunds.js",
        old_string: "const refundCents = Math.floor((returnedValue / subtotal) * paid);",
        new_string: "// Refund Policy §2: round half up to the nearest cent.\n  const refundCents = Math.round((returnedValue / subtotal) * paid);",
      },
    },
  });
  if (opts.canRunTests) steps.push({ text: "Re-running the tests:", tool: { name: "run_command", input: { command: "npm test" } } });
  steps.push({
    text: [
      "**Root cause:** `calculateRefund` rounded the prorated amount *down* with `Math.floor` (`src/refunds.js:" + floorLine + "`). In issue #42 the customer's share was 499.5¢, which became 499¢ ($4.99).",
      "",
      `**Policy:** Refund Policy §2 says amounts are rounded *half up* to the nearest cent and must never be rounded down (\`@confluence/refund-policy:${roundingStart}-${roundingEnd}\`).`,
      "",
      `**Fix:** switched to \`Math.round\`, so 499.5¢ becomes 500¢ ($5.00).${opts.canRunTests ? " `npm test` failed on the half-cent case before the change and passes now." : " Run `npm test` to confirm."}`,
      "",
      `**Also worth flagging:** the code allows refunds for 60 days (\`REFUND_WINDOW_DAYS\`, \`src/refunds.js:${windowLine}\`), but the Refund Policy still says 30 days (\`@confluence/refund-policy:${eligibilityLine}\`). Issue #51 shows finance approved 60 days and left the Confluence update unchecked, so the doc is out of date, not the code. Want me to draft the policy update?`,
    ].join("\n"),
  });
  return steps;
}
