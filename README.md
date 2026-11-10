# Codify Buddy

**An AI coding copilot for your terminal that knows your code, your docs and your tools.**

Codify Buddy indexes the repository you run it in, answers questions with
citations you can jump to (`src/auth/session.ts:42-80`), and plans and makes
changes: it reads files, edits code and runs your tests, behind a permission
gate you control.

```bash
npx codify-buddy
```

That's the whole setup. The first run asks for your Anthropic API key once,
indexes the project in the background, and drops you into a chat.

---

## Install

| Method | Command | Needs |
|---|---|---|
| Run without installing | `npx codify-buddy` | Node.js 20+ |
| Install globally | `npm i -g codify-buddy` | Node.js 20+ |
| Standalone binary | `curl -fsSL https://raw.githubusercontent.com/RohanMAshlesh/codify-buddy/main/scripts/install.sh \| sh` | nothing |

The standalone binary bundles its own runtime, so machines without Node.js can
use it too. Binaries for macOS, Linux and Windows are attached to each
[release](https://github.com/RohanMAshlesh/codify-buddy/releases), and the
installer verifies their SHA-256 checksums.

## Quick start

```bash
cd your-project
codify                                   # interactive chat
codify "how does authentication work?"   # one question, then exit
codify login                             # store or replace your API key
codify doctor                            # check that everything is set up
```

Credentials are read from `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`)
first, then from `~/.codify/credentials.json`, which `codify login` writes
with owner-only permissions.

## What it can do

- **Answer questions about your codebase, with sources.** It searches the
  index first, reads only the lines it needs, and cites `path:line`.
- **Make changes.** Edits are shown as diffs and need your approval unless
  you've chosen a more permissive mode.
- **Verify its work.** It runs your tests, type checker or linter and reports
  the real result.
- **Work with piped input.** `cat error.log | codify "why is this failing?"`
- **Run in scripts and CI.** `codify --json "..."` streams newline-delimited
  JSON events and exits with a status code.
- **Search offline.** `codify search "refund flow"` queries the local index
  with no model call and no network.

## Commands

| Command | Description |
|---|---|
| `codify [prompt]` | Interactive chat, or a single run when a prompt is given |
| `codify -p "..."` | Run once and print the answer |
| `codify --json "..."` | Run once and stream JSON events |
| `codify -c` / `codify -r <id>` | Continue the last session / resume a session |
| `codify search <query>` | Search the project index (offline) |
| `codify index [--rebuild]` | Build or refresh the index |
| `codify sessions` | List saved sessions |
| `codify config list\|get\|set` | View or change settings |
| `codify doctor` | Diagnose runtime, credentials, API access and index |
| `codify login` / `logout` | Store or remove your API key |
| `codify serve --stdio` | Run the engine as a JSON-RPC server for IDE extensions |

Inside the chat: `/help`, `/new`, `/sessions`, `/resume <id>`, `/search <q>`,
`/mode <mode>`, `/effort <level>`, `/model <id>`, `/cost`, `/exit`. Press
Ctrl+C to interrupt a running turn.

## Permission modes

| Mode | Reads | File edits | Shell commands |
|---|---|---|---|
| `ask` (default) | automatic | asks first | asks first |
| `auto-edit` | automatic | automatic | asks first |
| `yolo` | automatic | automatic | automatic |
| `read-only` | automatic | blocked | blocked |

Non-interactive runs (`-p`, `--json`, piped output) default to `read-only`, so
a CI job never changes files unless you pass `--mode` explicitly. The file
tools are confined to the project root, and symlinks pointing outside it are
rejected. Shell commands run with your user's permissions, which is why they
ask first by default.

## Configuration

Settings are layered from lowest to highest priority: defaults,
`~/.codify/config.json`, `<project>/.codify/config.json`, environment
variables (`CODIFY_MODEL`, `CODIFY_EFFORT`, `CODIFY_PERMISSION_MODE`), then
command-line flags.

```bash
codify config set effort high              # this project
codify config set --global model claude-sonnet-5-5
codify config set context.budgetTokens 20000
```

| Key | Default | Meaning |
|---|---|---|
| `model` | `claude-opus-5-5` | Model used for the agent |
| `effort` | `medium` | Thinking effort: `low` · `medium` · `high` · `xhigh` · `max` |
| `permissionMode` | `ask` | See the permission modes above |
| `maxTokens` | `64000` | Output cap per model call |
| `maxTurns` | `50` | Max model calls per request |
| `fallbacks` | `true` | Server-side refusal fallback (Claude API) |
| `context.budgetTokens` | `12000` | Tokens of retrieved code per search |
| `context.repoMapTokens` | `3000` | Size of the repo map in the system prompt |
| `context.maxFileBytes` | `1000000` | Skip files larger than this |
| `context.extraIgnore` | `[]` | Extra gitignore-style patterns |

### Project memory

Put team conventions in a `CODIFY.md` at the repo root (`AGENTS.md` and
`CLAUDE.md` are also recognised). It's included in every session, so the
agent follows your rules without being told each time.

### Ignoring files

The index honours `.gitignore` at every level, plus a `.codifyignore` file and
built-in defaults (`node_modules`, build output, lockfiles, binaries). Index
and session data live in `<project>/.codify/`, which ignores itself in git.

## How it works

```
codify CLI ─┐                 ┌─ Context engine: walker → symbol chunker →
VS Code   ──┼─ Engine ────────┤  BM25 index + import graph → ranked, cited snippets
CI (--json) ┘  (agent loop)   ├─ Tools: search · read · grep · edit · write · shell · git
                              ├─ Permission gate
                              └─ Model: Claude Opus 5.5, adaptive thinking, prompt caching
```

- **Context engine.** Code is chunked by symbol (functions, classes,
  methods) and docs by heading, then indexed with BM25. Symbol and path
  matches are boosted and imports form a graph. Updates are incremental by
  content hash. It's pure TypeScript with no native modules, which is what
  lets `npx` and the single binary work everywhere.
- **Prompt caching.** Tools, the system prompt and a per-session repo map
  form a stable prefix that is cached. Later turns re-read it at about a
  twentieth of the normal input price.
- **One engine, many clients.** The CLI uses the engine directly. IDEs talk
  to the same engine over `codify serve --stdio`, which is newline-delimited
  JSON-RPC 2.0 (see `src/rpc/server.ts`).

More detail is in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap

- [x] **P0** CLI, agent loop, tools, permissions, config, packaging, doctor
- [x] **P1** Local context engine: index, retrieval, citations, repo map
- [ ] **P2** Connectors: GitHub, Confluence, Jira, MCP client, and an MCP server exposing the context engine
- [ ] **P3** VS Code extension on `codify serve`
- [ ] **P4** Team mode: shared indexes, SSO, audit log, policies, budgets
- [ ] **P5** Doc-drift detection, PR review action, ticket → PR

## Development

```bash
npm install
npm test            # vitest
npm run typecheck
npm run build       # dist/cli.js
npm run binary      # standalone binary (requires Bun)
node dist/cli.js    # run the local build
```

## License

MIT © RohanMAshlesh
