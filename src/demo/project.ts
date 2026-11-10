import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * A small, dependency-free sample project used by `codify demo`. It has a
 * planted rounding bug (an issue reports it, the policy doc defines the right
 * behaviour, a test reproduces it) and one piece of stale documentation, so a
 * demo can show code + docs + issues working together.
 */
export const DEMO_FILES: Record<string, string> = {
  "package.json": JSON.stringify(
    { name: "acme-payments", version: "1.4.0", private: true, type: "module", scripts: { test: "node --test test/refunds.test.js test/ledger.test.js" } },
    null,
    2,
  ) + "\n",

  "README.md": `# Acme Payments

Order refunds and the payments ledger for the Acme store.

- \`src/refunds.js\` calculates refunds for returned items
- \`src/ledger.js\` records money movements
- \`src/money.js\` integer-cent helpers

Run the tests with \`npm test\` (Node.js 20+, no dependencies).
`,

  "CODIFY.md": `# Team conventions

- Money is always integer cents. Never store or compare floating-point amounts.
- Business rules come from the Payments space in Confluence; cite the policy when you change behaviour.
- Run \`npm test\` after every change.
`,

  "src/money.js": `/** Money is always handled as integer cents. */

export function toCents(amount) {
  return Math.round(Number(amount) * 100);
}

export function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return \`\${sign}$\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, "0")}\`;
}
`,

  "src/refunds.js": `import { formatCents } from "./money.js";

/** Refunds are accepted for this many days after purchase. */
export const REFUND_WINDOW_DAYS = 60;

/**
 * Prorate a refund for the returned items of an order.
 *
 * @param {{ items: { sku: string, priceCents: number }[], discountCents: number, purchasedAt: string }} order
 * @param {string[]} returnedSkus
 */
export function calculateRefund(order, returnedSkus, now = new Date()) {
  const ageDays = (now - new Date(order.purchasedAt)) / 86_400_000;
  if (ageDays > REFUND_WINDOW_DAYS) {
    throw new Error(\`Refund window of \${REFUND_WINDOW_DAYS} days has passed\`);
  }

  const subtotal = order.items.reduce((sum, item) => sum + item.priceCents, 0);
  const returnedValue = order.items
    .filter((item) => returnedSkus.includes(item.sku))
    .reduce((sum, item) => sum + item.priceCents, 0);

  // Spread the order discount across items in proportion to their price.
  const paid = subtotal - order.discountCents;
  const refundCents = Math.floor((returnedValue / subtotal) * paid);

  return { refundCents, display: formatCents(refundCents) };
}
`,

  "src/ledger.js": `/** Append-only ledger of money movements, in integer cents. */

export function createLedger() {
  return { entries: [] };
}

export function recordPayment(ledger, orderId, amountCents) {
  ledger.entries.push({ type: "payment", orderId, amountCents });
}

/** Refunds are recorded as negative entries (see the Ledger Runbook). */
export function recordRefund(ledger, orderId, refund) {
  ledger.entries.push({ type: "refund", orderId, amountCents: -refund.refundCents });
}

export function balance(ledger) {
  return ledger.entries.reduce((sum, e) => sum + e.amountCents, 0);
}
`,

  "test/refunds.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateRefund } from "../src/refunds.js";

const order = {
  items: [
    { sku: "MUG", priceCents: 500 },
    { sku: "TEE", priceCents: 500 },
  ],
  discountCents: 1,
  purchasedAt: "2026-11-01",
};
const soon = new Date("2026-11-05");

test("full refund returns everything the customer paid", () => {
  assert.equal(calculateRefund(order, ["MUG", "TEE"], soon).refundCents, 999);
});

test("partial refunds round half up to the cent (Refund Policy §2)", () => {
  // The customer's share of 999¢ for one of two equal items is 499.5¢.
  assert.equal(calculateRefund(order, ["MUG"], soon).refundCents, 500);
});

test("refunds outside the window are rejected", () => {
  assert.throws(() => calculateRefund(order, ["MUG"], new Date("2027-02-01")), /window/);
});
`,

  "test/ledger.test.js": `import assert from "node:assert/strict";
import { test } from "node:test";
import { balance, createLedger, recordPayment, recordRefund } from "../src/ledger.js";

test("refunds reduce the balance", () => {
  const ledger = createLedger();
  recordPayment(ledger, "o1", 999);
  recordRefund(ledger, "o1", { refundCents: 500 });
  assert.equal(balance(ledger), 499);
});
`,

  "wiki/refund-policy.md": `# Refund Policy

Owner: Payments team · Space: PAY · Last reviewed: 2026-03-02

## 1. Eligibility

Customers may request a refund within **30 days** of purchase.

## 2. Partial refunds

When only some items in an order are returned, the refund is the returned
items' share of what the customer actually paid (after discounts), prorated by
item price.

Amounts are calculated in integer cents and **rounded half up** to the nearest
cent. Never round down: it short-changes the customer and breaks
reconciliation with the card processor.

## 3. Recording refunds

Every refund is written to the ledger as a negative entry. See the Ledger
Runbook.
`,

  "wiki/ledger-runbook.md": `# Ledger Runbook

Owner: Payments team · Space: PAY

## Entries

The ledger is append-only. Payments are positive entries and refunds are
negative entries, both in integer cents.

## Reconciliation

Finance reconciles the ledger against the card processor nightly. Any
difference, even one cent, opens a reconciliation ticket.
`,

  "wiki/architecture.md": `# Payments Architecture

Space: PAY

The payments service has three modules: \`refunds\` (eligibility and
amounts), \`ledger\` (append-only money movements) and \`money\`
(integer-cent helpers). Refund amounts flow from \`calculateRefund\` into
\`recordRefund\`.
`,

  "issues/42-partial-refund-one-cent-short.md": `# #42 Partial refund is one cent short

Issue #42 · open · by @maria-support · labels: bug, payments · updated 2026-11-06

A customer bought two $5.00 items with a 1¢ promo discount and returned one.
They were refunded **$4.99**, but finance expected **$5.00**. Nightly
reconciliation flagged the 1¢ difference.

## Comments

**@dev-lee** (2026-11-06): Probably a rounding issue somewhere in refunds.js?
`,

  "issues/51-extend-refund-window.md": `# #51 Extend the refund window to 60 days

Issue #51 · closed · by @finance-ops · labels: policy · updated 2026-09-12

Finance approved extending the refund window from 30 to 60 days for all
customers, effective 2026-09-15. Implemented in PR #53 (\`REFUND_WINDOW_DAYS\`).

- [x] Update \`REFUND_WINDOW_DAYS\`
- [ ] Update the Refund Policy page in Confluence
`,
};

export const DEMO_CONNECTORS = [
  { id: "confluence", type: "docs", path: "wiki", label: "Confluence · PAY space (demo export)" },
  { id: "github", type: "docs", path: "issues", label: "GitHub issues · acme/payments (demo snapshot)" },
];

/** Write the demo project to `dir`. Fails if `dir` exists and isn't empty unless `force`. */
export function createDemoProject(dir: string, force = false): void {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0 && !force) {
    throw new Error(`${dir} already exists and is not empty. Pass --force to overwrite the demo files, or choose another folder.`);
  }
  for (const [rel, contents] of Object.entries(DEMO_FILES)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  fs.mkdirSync(path.join(dir, ".codify"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".codify", "config.json"), JSON.stringify({ connectors: DEMO_CONNECTORS }, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");

  // A git history makes diffs and `git status` meaningful during the demo.
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    if (!fs.existsSync(path.join(dir, ".git"))) git("init", "-q");
    git("add", "-A");
    git("-c", "user.name=Codify Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "Acme Payments v1.4.0");
  } catch {
    // git is optional
  }
}

/** 1-based line number of the first line containing `needle`. */
export function lineOf(text: string, needle: string): number {
  const i = text.split("\n").findIndex((l) => l.includes(needle));
  return i + 1;
}
