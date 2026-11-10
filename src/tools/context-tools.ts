import { z } from "zod";
import type { SearchHit } from "../context/index.js";
import type { Tool } from "./types.js";

function attr(name: string, value: string | undefined): string {
  return value ? ` ${name}="${value.replace(/"/g, "&quot;")}"` : "";
}

export function formatHit(h: SearchHit): string {
  const attrs =
    attr("citation", h.citation) +
    attr("source", h.source ?? "project") +
    attr("title", h.title) +
    attr("url", h.url) +
    (h.source ? "" : attr("symbol", h.symbol));
  return `<result${attrs}>\n${h.text}\n</result>`;
}

export const searchContextTool: Tool<{ query: string; scope?: "all" | "code" | "docs"; path_filter?: string; limit?: number }> = {
  name: "search_context",
  description:
    "Search everything Codify Buddy has indexed: project code and docs, plus connected sources such as Confluence pages, GitHub issues/PRs and Jira tickets. Returns ranked snippets with citations (path:start-end, or @source/... for connected documents, with a url when available) and related files from the import graph. Use this first to orient before reading files.",
  access: "read",
  schema: z.object({
    query: z.string().min(1).describe("Natural language or identifiers, e.g. 'how are refunds rounded' or 'UserService.findById'"),
    scope: z.enum(["all", "code", "docs"]).optional().describe("all (default), code = project files only, docs = connected sources only"),
    path_filter: z.string().optional().describe("Only return results whose path or @source URI contains this string"),
    limit: z.number().int().positive().max(20).optional(),
  }),
  describe: (i) => `search "${i.query}"${i.scope && i.scope !== "all" ? ` in ${i.scope}` : ""}`,
  async run(input, ctx) {
    const limit = input.limit ?? 8;
    const res = ctx.index.search(input.query, {
      limit,
      scope: input.scope,
      pathFilter: input.path_filter,
      budgetTokens: ctx.config.context.budgetTokens,
    });
    // Team sources: shared, permission-filtered documents from the team server.
    let teamNote = "";
    if (ctx.remote && input.scope !== "code") {
      try {
        let remote = await ctx.remote.search(input.query, { limit, budgetTokens: ctx.config.context.budgetTokens });
        if (input.path_filter) remote = remote.filter((h) => h.path.includes(input.path_filter!));
        const seen = new Set(res.hits.map((h) => h.citation));
        res.hits = [...res.hits, ...remote.filter((h) => !seen.has(h.citation))].sort((a, b) => b.score - a.score).slice(0, limit);
      } catch (err) {
        teamNote = `\n\n(Team sources at ${ctx.remote.label} unavailable: ${(err as Error).message})`;
      }
    }
    if (res.hits.length === 0) {
      return { content: "No results. Try different terms, grep for exact strings, or find_files.", summary: `search "${input.query}" → 0 hits` };
    }
    const related = res.related.length ? `\n\nRelated files (imports/imported-by): ${res.related.join(", ")}` : "";
    return {
      content: res.hits.map(formatHit).join("\n\n") + related + teamNote,
      summary: `search "${input.query}" → ${res.hits.length} hits (${res.hits.slice(0, 3).map((h) => h.citation).join(", ")})`,
    };
  },
};
