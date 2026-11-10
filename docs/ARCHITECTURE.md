# Codify Buddy — Architecture

> An AI coding copilot that knows your code, your docs and your tools.
> Runs from any terminal with zero setup; scales up to a shared team server.

## 1. Product principles

1. **Zero-setup first run.** `cd repo && codify` must work with nothing but a
   model credential. No config files, no native dependencies, no daemon to
   install.
2. **Context is the product.** The agent loop is table stakes. The
   differentiator is the *Context Engine*: retrieval across code, docs and
   tools, with citations and permission-awareness.
3. **One engine, thin clients.** CLI, VS Code, JetBrains and CI all talk to the
   same engine (in-process, or over JSON-RPC on stdio — the LSP pattern).
4. **Safe by default.** Reads run automatically; writes, shell commands and
   network calls go through a permission gate whose policy users and admins
   control.
5. **Local by default, team when ready.** Local mode is the full product for
   one developer. Team mode is an optional backend for the same CLI (shared
   indexes, SSO, audit, budgets).

## 2. System overview

```
 CLIENTS:   codify (CLI/REPL)   VS Code ext   JetBrains   CI (headless --json)
                │                    │
                │ in-process         │ JSON-RPC over stdio (`codify serve`)
                ▼                    ▼
 ENGINE ┌──────────────────────────────────────────────────────────────┐
        │ Session      conversation state, persistence, resume          │
        │ Agent        plan → act → verify loop over tools, streaming   │
        │ Tools        fs / search / shell / git  + permission gate     │
        │ Context      index → retrieve → rank → budget → cite          │
        │ Connectors   GitHub, Confluence, Jira, docs → sync + live tools│
        │ MCP          client hub (external tools) + context server     │
        │ Model        Anthropic API (Bedrock/Vertex later), caching,   │
        │              refusal fallbacks, usage accounting              │
        └──────────────────────────────────────────────────────────────┘
 STORAGE   local: <repo>/.codify/ (index, sessions)  ~/.codify/ (config, creds)
           team (P4): Postgres + pgvector, object store
```

## 3. Source layout

```
src/
  cli/        command definitions, REPL, terminal rendering
  engine/     Engine facade: sessions, agent loop, event stream
  model/      Anthropic client wrapper, request shaping, usage/cost
  tools/      tool registry, built-in tools, permission gate
  context/    walker, chunker, BM25 index, code graph, retriever, repo map
  config/     config + credential resolution
  connectors/ GitHub, Confluence, Jira, docs-folder connectors + manager
  mcp/        MCP client hub and read-only MCP context server
  demo/       sample project + replay transport for `codify demo`
  rpc/        JSON-RPC stdio server for IDE clients
  util/       shared helpers
```

## 4. Context Engine (P1)

| Stage | Implementation |
|---|---|
| Walk | Respects `.gitignore` + `.codifyignore`, skips binaries and files > 1 MB |
| Chunk | Language-aware symbol chunker (functions, classes, methods) with a line-window fallback; markdown split by headings. Pluggable so tree-sitter can replace the heuristics without touching callers. |
| Index | Pure-TypeScript BM25 inverted index with field boosts (symbol, path, body). No native modules, so `npx` and single-binary builds just work. Incremental: files re-chunked only when their content hash changes. |
| Graph | Import/require edges between files, used to expand results with direct neighbours. |
| Retrieve | Query tokenisation splits `camelCase`/`snake_case`; BM25 + symbol/path boosts + graph expansion; per-file diversity cap. |
| Budget | Fits ranked chunks into a token budget and emits `path:start-end` citations. |
| Repo map | Compact tree + top symbols, placed in the cached system prompt so every turn starts oriented. |

Embeddings and LLM reranking are optional plug-ins (P1.5): enabled when a
provider is configured, never required.

### Connector documents

Connectors return plain-text documents (`ExternalDocInput`). The index
chunks them by heading and stores them per source in
`.codify/connectors/<id>.json`, separate from the code index, so a sync never
rewrites the code index and the reverse. Each document gets a citation URI
(`@<source>/<slug>`) and keeps its web URL. `search_context` covers both kinds
(`scope: all | code | docs`), and `read_file` opens `@…` URIs. Docs folders
inside the project are excluded from the code walk, so they're indexed once.

## 4b. Connectors and MCP

| Piece | Behaviour |
|---|---|
| `Connector` interface | `test()` · `sync()` → documents · `tools()` → live read-only tools |
| GitHub | REST v3; issues + PRs with recent comments; live `get_issue` (+ PR diff) and `search` |
| Confluence | Cloud REST v2 (cursor pagination, email + API token) or Data Center REST v1 (PAT); storage format → Markdown; live CQL search + page fetch |
| Jira | Cloud v3 `search/jql` (token pagination, ADF → text) or DC v2; optional sync JQL; live JQL + issue fetch |
| Docs folder | Markdown/text/HTML on disk; offline |
| Secrets | env vars → `~/.codify/credentials.json` (0600, keyed `<type>:<host>`) → `gh auth token` |
| Permission-awareness | Every call uses the user's own token, so the index holds only what that user can see. Team mode (P4) will store source ACLs and filter at query time. |
| MCP client | stdio + streamable HTTP; tools exposed as `mcp__<server>__<tool>` with raw JSON schemas; `exec` access (asks) unless `readOnlyHint` or the server is `trusted`; connected in `Engine.open()` before the session so the tool list stays cache-stable |
| MCP server | `codify mcp serve`: read-only `search_context`, `read_document`, `find_files`, `list_sources` |

## 4c. Demo

`codify demo` writes a dependency-free sample project (planted rounding bug,
policy doc, issues, and a stale doc that contradicts the code), syncs it as
two docs connectors and runs the scenario. With credentials it runs live,
with the first prompt pre-filled. Without credentials, `ReplayTransport`
plays the recorded model messages through the real engine, so search, reads,
the edit (behind the permission prompt) and the test runs all execute for
real. A test keeps the recording consistent with the project files.

## 4d. VS Code extension (P3)

The extension is a thin client. It runs the bundled engine
(`vscode/dist/server/codify.mjs`, the CLI built with all its dependencies) as
a child process with VS Code's own runtime, and talks to it over `codify
serve`'s JSON-RPC.

| Piece | Behaviour |
|---|---|
| `EngineClient` | Spawns the engine and handles request/response, engine → client requests (`permission/request`) and notifications (`chat/event`); restarts on demand |
| `Controller` | Lifecycle (lazy start on first use), API key from SecretStorage passed as an env var, approvals, the native diff (`vscode.diff` on virtual before/after documents), citations, search, modes, sessions |
| Chat webview | Streams Markdown (a safe subset; all HTML escaped), tool rows with failing-test highlights, approval cards; citations post back to the extension |
| RPC additions | `chat/setMode \| setEffort \| setModel`, `context/read`, `sources/list`, `sessions/resume` (with transcript), error `-32001` when no API key; approval requests carry full before/after contents |
| Tests | Engine client against the real bundled engine; controller end to end against a VS Code API mock, the real engine and a local Anthropic-protocol server; webview rendered in Chromium; CI runs the extension in real VS Code |

## 5. Agent loop

* Manual streaming loop on the Messages API (`claude-opus-5-5`, adaptive
  thinking, effort configurable, default `medium`).
* Prompt layout is cache-friendly: tools → frozen system prompt + repo map →
  conversation. Volatile data never enters the prefix.
* Every tool input is validated (zod) before execution; paths are confined to
  the project root.
* Stop reasons are handled explicitly: `tool_use`, `pause_turn`, `max_tokens`,
  `refusal`. Server-side refusal fallback is enabled by default.
* The loop emits a typed event stream (`text`, `tool_call`, `tool_result`,
  `permission_request`, `usage`, `done`, `error`) that every client renders.

## 6. Permissions

| Mode | Reads | Writes | Shell |
|---|---|---|---|
| `ask` (default) | auto | ask | ask |
| `auto-edit` | auto | auto | ask |
| `yolo` | auto | auto | auto |
| `read-only` | auto | deny | deny |

Headless runs default to `read-only` unless a mode is passed explicitly.

## 7. Distribution

* `npx codify-buddy` / `npm i -g codify-buddy` (Node ≥ 20).
* Standalone binary via `bun build --compile` for macOS, Linux and Windows.
* `install.sh` one-liner that fetches the right binary.
* `codify doctor` diagnoses credentials, network, index and config.

## 8. Roadmap

| Phase | Scope |
|---|---|
| **P0** | CLI/REPL, engine, agent loop, tools, permissions, config, packaging, doctor |
| **P1** | Context engine: index, retrieval, citations, repo map |
| **P2** | Connectors: GitHub, Confluence, Jira, docs; MCP client + MCP server; `codify demo` |
| **P3** | VS Code extension over `codify serve` (shipped) |
| P4 | Team server: SSO, shared indexes, audit, policy, budgets |
| P5 | Doc-drift detection, PR review action, ticket → PR |
