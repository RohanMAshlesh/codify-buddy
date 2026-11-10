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
        │ Connectors   GitHub, Confluence, Jira, MCP (P2)               │
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
| P2 | Connectors: GitHub, Confluence, Jira, MCP client + MCP server |
| P3 | VS Code extension over `codify serve` |
| P4 | Team server: SSO, shared indexes, audit, policy, budgets |
| P5 | Doc-drift detection, PR review action, ticket → PR |
