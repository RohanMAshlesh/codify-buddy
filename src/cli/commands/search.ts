import pc from "picocolors";
import type { ContextIndex } from "../../context/index.js";

export interface PrintSearchOptions {
  limit?: number;
  json?: boolean;
  pathFilter?: string;
  /** Lines of snippet to show per hit. */
  preview?: number;
}

/** Print search results; used by `codify search` and the `/search` REPL command. */
export function printSearch(index: ContextIndex, query: string, opts: PrintSearchOptions = {}): void {
  const res = index.search(query, { limit: opts.limit ?? 10, pathFilter: opts.pathFilter });
  if (opts.json) {
    process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    return;
  }
  if (res.hits.length === 0) {
    process.stdout.write(pc.dim(`No results for "${query}".\n`));
    return;
  }
  const previewLines = opts.preview ?? 4;
  for (const h of res.hits) {
    const sym = h.symbol ? pc.bold(h.symbol) + pc.dim(` (${h.kind})`) : pc.dim(h.kind);
    process.stdout.write(`${pc.cyan(h.citation)}  ${sym}  ${pc.dim(`score ${h.score}`)}\n`);
    const lines = (h.text ?? "").split("\n").filter((l) => l.trim()).slice(0, previewLines);
    for (const l of lines) process.stdout.write(pc.dim("    " + l.slice(0, 160)) + "\n");
  }
  if (res.related.length) process.stdout.write(pc.dim(`related: ${res.related.join(", ")}\n`));
}
