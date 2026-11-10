# Demo script: Codify Buddy in five minutes

A presenter's guide for showing Codify Buddy to engineers, engineering
managers or buyers. It runs offline and needs nothing installed beyond
Node.js 20+.

## Before you start

```bash
npx codify-buddy demo --force        # or: codify demo --force
```

- **No API key?** The demo **replays** a recorded session. The model's
  messages are pre-recorded, but every tool call (search, file reads, the
  edit, the test runs) executes for real against the sample project, and the
  screen says so. This is the safe choice for a stage or a flaky network.
- **Have a key?** `codify login`, then `codify demo --live --force` runs the
  same scenario against Claude, with the first prompt pre-filled.
- Use a terminal at least 100 columns wide with a dark theme, and raise the
  font size.

## The story (what the audience should take away)

> Most coding assistants know your code. Codify Buddy also knows what your
> team *wrote down*: the Confluence policy, the GitHub issue, the runbook.
> It uses them to fix the right thing, and it tells you when they disagree.

## Walkthrough

| Time | On screen | Say |
|---|---|---|
| 0:00 | `codify demo` creates *Acme Payments* and lists its context: code, `@confluence` (3 pages), `@github` (2 issues), `CODIFY.md` | "Here's a small payments service, with its Confluence space and GitHub issues connected. In real use that's `codify connect confluence`." |
| 0:30 | The prompt: *"Issue #42 says a customer was refunded $4.99 instead of $5.00…"* | "A support ticket came in. I'm asking it the way I'd ask a teammate." |
| 0:45 | `search_context` returns the policy page, the issue **and** `src/refunds.js` | "One search across code *and* docs. Notice the hits from Confluence and GitHub." |
| 1:15 | It reads the code, then the policy page by its `@confluence/...` URI | "It's reading the actual policy, not guessing what 'correct' means." |
| 1:45 | `npm test` → `not ok 3 … expected: 500, actual: 499` | "Before changing anything, it reproduces the bug with the real test suite." |
| 2:15 | The diff and the permission prompt; press **y** | "Edits need my approval, and I see the diff first. Admins can lock this down." |
| 2:45 | `npm test` → `# pass 4` | "Green." |
| 3:00 | The summary, with citations to `src/refunds.js:25` and `@confluence/refund-policy:9-17` | "Every claim has a source I can click." |
| 3:30 | **"Also worth flagging"**: the 60-day code vs the 30-day policy, explained by issue #51 | "This is the moment. Nobody asked, but it noticed the *documentation* is stale, and why. That's what happens when the assistant has the whole context." |
| 4:15 | `cd codify-demo && git diff`, then `codify search "refund window"` | "It's a normal git change. And search works offline, with no model call." |
| 4:45 | Close | "Terminal today, VS Code next. The same engine also serves this context to other agents over MCP." |

## Likely questions

- **"Does it see things I can't?"** No. Each connector uses *your* token, so
  results are limited to what your account can access. Team mode with shared
  indexes respects source permissions too.
- **"Where does my code go?"** The index is local (`.codify/`). Only the
  snippets the agent reads are sent to the model, under your API agreement.
- **"Can it run anything?"** Reads are automatic. Edits and commands ask
  first by default, CI runs are read-only, and file access is confined to
  the project.
- **"What about our other tools?"** Any MCP server plugs in with
  `codify mcp add`. Codify Buddy is also an MCP server
  (`codify mcp serve`), so Claude Code or Cursor can use its context.
- **"What does it cost?"** The status line after each answer shows tokens and
  an estimated cost. Prompt caching keeps repeat turns cheap.

## Follow-ups for a live session

1. *Is our Refund Policy page up to date with the code? Cite both.*
2. *Explain how a refund flows from calculation to the ledger, with citations.*
3. *Draft the Confluence update for the Refund Policy based on issue #51.*
