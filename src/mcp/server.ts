import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { loadConfig } from "../config/config.js";
import { findProjectRoot } from "../config/paths.js";
import { ContextIndex, indexOptionsFor } from "../context/index.js";
import { formatHit } from "../tools/context-tools.js";
import { findFilesTool, readFileTool } from "../tools/fs-tools.js";
import type { ToolContext } from "../tools/types.js";

const REFRESH_MS = 30_000;

/**
 * Exposes Codify Buddy's context engine as a read-only MCP server, so other
 * agents (Claude Code, Cursor, …) can search code plus connected docs.
 */
export function createContextServer(cwd?: string): { server: McpServer; index: ContextIndex } {
  const root = findProjectRoot(cwd);
  const config = loadConfig(root);
  const index = new ContextIndex(root, indexOptionsFor(root, config));
  index.load();
  index.update();
  let lastRefresh = Date.now();
  const fresh = () => {
    if (Date.now() - lastRefresh > REFRESH_MS) {
      index.update();
      lastRefresh = Date.now();
    }
  };
  const ctx: ToolContext = { root, config, index };
  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

  const server = new McpServer(
    { name: "codify-buddy", version: pkg.version },
    { instructions: "Search this project's code and its connected documentation (Confluence, GitHub issues, Jira, doc folders) with citations. Start with search_context." },
  );

  server.registerTool(
    "search_context",
    {
      description:
        "Ranked search over the project's code and connected sources (Confluence, GitHub issues/PRs, Jira, doc folders). Returns snippets with citations (path:start-end or @source/...:start-end) and URLs.",
      inputSchema: {
        query: z.string().min(1).describe("Natural language or identifiers"),
        scope: z.enum(["all", "code", "docs"]).optional(),
        limit: z.number().int().positive().max(20).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, scope, limit }) => {
      fresh();
      const res = index.search(query, { scope, limit: limit ?? 8, budgetTokens: config.context.budgetTokens });
      if (!res.hits.length) return text("No results.");
      const related = res.related.length ? `\n\nRelated files: ${res.related.join(", ")}` : "";
      return text(res.hits.map(formatHit).join("\n\n") + related);
    },
  );

  server.registerTool(
    "read_document",
    {
      description: "Read a project file (path relative to the project root) or a connected document by its @source/... URI. Returns numbered lines.",
      inputSchema: {
        path: z.string().min(1),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      try {
        return text((await readFileTool.run(input, ctx)).content);
      } catch (err) {
        return text((err as Error).message, true);
      }
    },
  );

  server.registerTool(
    "find_files",
    {
      description: "Find project files whose path contains all given space-separated fragments.",
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      fresh();
      return text((await findFilesTool.run(input, ctx)).content);
    },
  );

  server.registerTool(
    "list_sources",
    {
      description: "List what is indexed: project file counts and each connected source with its document count and last sync time.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const sources = index.sources().map((s) => `- @${s.id}: ${s.label} (${s.kind}), ${s.docs} documents, synced ${s.syncedAt}`);
      return text([`Project: ${root}`, `Files: ${index.fileCount} (${index.chunkCount} chunks incl. documents)`, "Sources:", ...(sources.length ? sources : ["- none (run `codify connect`)"])].join("\n"));
    },
  );

  return { server, index };
}

export async function serveMcp(transport: Transport = new StdioServerTransport()): Promise<void> {
  const { server } = createContextServer();
  await server.connect(transport);
}
