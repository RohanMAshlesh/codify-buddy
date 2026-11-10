import { z } from "zod";
import type { Tool } from "./types.js";

export const searchCodeTool: Tool<{ query: string; path_filter?: string; limit?: number }> = {
  name: "search_code",
  description:
    "Search the indexed project (code and docs) by concept or identifier. Returns ranked snippets with citations (path:start-end) and related files from the import graph. Use this first to orient before reading files.",
  access: "read",
  schema: z.object({
    query: z.string().min(1).describe("Natural language or identifiers, e.g. 'where are refunds issued' or 'UserService.findById'"),
    path_filter: z.string().optional().describe("Only return results whose path contains this string"),
    limit: z.number().int().positive().max(20).optional(),
  }),
  describe: (i) => `search "${i.query}"`,
  async run(input, ctx) {
    const res = ctx.index.search(input.query, {
      limit: input.limit ?? 8,
      pathFilter: input.path_filter,
      budgetTokens: ctx.config.context.budgetTokens,
    });
    if (res.hits.length === 0) {
      return { content: "No results. Try different terms, grep for exact strings, or find_files.", summary: `search "${input.query}" → 0 hits` };
    }
    const blocks = res.hits.map((h) => {
      const label = h.symbol ? ` (${h.kind} ${h.symbol})` : "";
      return `<result citation="${h.citation}"${label ? ` symbol="${h.symbol}"` : ""}>\n${h.text}\n</result>`;
    });
    const related = res.related.length ? `\n\nRelated files (imports/imported-by): ${res.related.join(", ")}` : "";
    return {
      content: blocks.join("\n\n") + related,
      summary: `search "${input.query}" → ${res.hits.length} hits (${res.hits.slice(0, 3).map((h) => h.citation).join(", ")})`,
    };
  },
};
