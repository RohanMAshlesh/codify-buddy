# Codify Buddy

**An AI coding copilot for your terminal that knows your code, your docs and your tools.**

Codify Buddy indexes the repository you run it in, together with your team's
Confluence pages, GitHub issues, Jira tickets and doc folders. It answers
questions with citations you can jump to (`src/auth/session.ts:42-80`,
`@confluence/eng/auth-design:12-30`), and it plans and makes changes: it
reads files, edits code and runs your tests, behind a permission gate you
control. Any MCP server plugs in as extra tools.

```bash
npx codify-buddy
```

That's the whole setup. The first run asks for your Anthropic API key once,
indexes the project in the background, and drops you into a chat.

### See it in 2 minutes, no API key needed

```bash
npx codify-buddy demo
```

This creates a sample payments service with a bug, a Confluence-style policy
and a GitHub-style issue. Codify Buddy then finds the root cause in the
policy, reproduces it with the real tests, fixes it, shows the tests passing,
and flags a stale doc along the way. Without a key, the model's side is
replayed from a recording while every tool call runs for real. With a key
(`codify demo --live`) it runs against Claude. The presenter script is in
[docs/DEMO.md](docs/DEMO.md).

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
- **Use your team's knowledge.** Connect Confluence, GitHub, Jira or a docs
  folder, and the agent searches them alongside the code. It cites them, and
  says when the code and the docs disagree.
- **Plug in any MCP server**, and **serve its context to other agents** over
  MCP.

## Connect your context

```bash
codify connect github                  # issues & PRs for this repo (detects owner/name from git)
codify connect confluence              # pages from Confluence spaces (Cloud or Data Center)
codify connect jira                    # Jira issues by JQL, plus live JQL search
codify connect docs --path ./docs      # any folder of .md/.txt/.html: ADRs, runbooks, wiki exports
codify connectors                      # what's connected and when it last synced
codify sync                            # refresh all sources
```

Each `connect` asks only for what it needs, tests the connection, saves the
settings to `.codify/config.json`, keeps the token in
`~/.codify/credentials.json` (owner-only), and indexes the source. Every
flag can also be passed for scripted setup, for example `codify connect
confluence --url https://acme.atlassian.net/wiki --email you@acme.com --space
ENG PAY -y`.

| Source | What gets indexed | Live tools for the agent | Token |
|---|---|---|---|
| GitHub | Issues and PRs with recent comments | `github_get_issue` (with PR diffs), `github_search` | `GITHUB_TOKEN`, `gh auth token`, or prompt; public repos work without one |
| Confluence | Pages in the chosen spaces | `confluence_search` (CQL), `confluence_get_page` | Cloud: email + API token · Data Center: personal access token |
| Jira | Issues matching your JQL (optional) | `jira_search` (JQL), `jira_get_issue` | Cloud: email + API token · Data Center: personal access token |
| Docs folder | `.md`, `.txt`, `.rst`, `.html` files | — | none |

Connectors use **your own** token, so search results never include anything
your account can't see. Synced documents live in `.codify/connectors/` on
your machine.

## MCP

**Use MCP servers as tools:**

```bash
codify mcp add files -- npx -y @modelcontextprotocol/server-filesystem ~/notes
codify mcp add search --url https://mcp.example.com/mcp --header "Authorization=Bearer …"
codify mcp list
```

MCP tools join the agent's toolbox as `mcp__<server>__<tool>`. Tools that
aren't marked read-only ask before running, unless you add the server with
`--trusted`.

**Serve Codify Buddy's context to other agents:**

```bash
claude mcp add codify -- npx -y codify-buddy mcp serve
```

`codify mcp serve` is a read-only MCP server with `search_context`,
`read_document`, `find_files` and `list_sources`. Claude Code, Cursor or any
MCP client can then search your code and connected docs with citations.

## Commands

| Command | Description |
|---|---|
| `codify [prompt]` | Interactive chat, or a single run when a prompt is given |
| `codify -p "..."` | Run once and print the answer |
| `codify --json "..."` | Run once and stream JSON events |
| `codify -c` / `codify -r <id>` | Continue the last session / resume a session |
| `codify demo [dir]` | Create a sample project and run the guided demo |
| `codify search <query>` | Search the project index (offline) |
| `codify connect <type>` | Connect GitHub, Confluence, Jira or a docs folder |
| `codify connectors` / `sync` / `disconnect` | List, refresh or remove connected sources |
| `codify mcp add\|list\|remove\|serve` | Manage MCP servers, or serve context over MCP |
| `codify index [--rebuild]` | Build or refresh the index |
| `codify sessions` | List saved sessions |
| `codify config list\|get\|set` | View or change settings |
| `codify doctor` | Diagnose runtime, credentials, API access, index and connectors |
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
| `connectors` | `[]` | Connected sources (managed by `codify connect`) |
| `mcp.servers` | `{}` | MCP servers (managed by `codify mcp add`) |

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
codify CLI ─┐                 ┌─ Context engine: code + connector docs → BM25 index
VS Code   ──┼─ Engine ────────┤  + import graph → ranked, cited snippets
CI (--json) ┘  (agent loop)   ├─ Tools: search · read · grep · edit · write · shell · git
MCP clients ─ codify mcp serve├─ Connectors: GitHub · Confluence · Jira · docs (sync + live tools)
                              ├─ MCP hub: external servers as tools
                              ├─ Permission gate
                              └─ Model: Claude Opus 5.5, adaptive thinking, prompt caching
```

- **Context engine.** Code is chunked by symbol (functions, classes,
  methods), and docs and connector pages by heading, all into one BM25 index. Symbol and path
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
- [x] **P2** Connectors (GitHub, Confluence, Jira, docs folders), MCP client, MCP context server, `codify demo`
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
