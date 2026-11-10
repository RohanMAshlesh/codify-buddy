import { estimateTokens } from "../util/tokens.js";
import type { ContextIndex } from "./index.js";

/**
 * Compact orientation map for the system prompt: directory tree with each
 * file's top-level symbols, trimmed to a token budget. Deterministic output so
 * it stays prompt-cache friendly.
 */
export function buildRepoMap(index: ContextIndex, budgetTokens: number): string {
  const entries = Object.entries(index.fileEntries()).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "(no indexed files)";

  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  // Prefer shallow files and files with symbols when trimming.
  const priority = (p: string, n: number) => p.split("/").length * 10 - Math.min(n, 9);
  const ordered = [...entries].sort(([a, ea], [b, eb]) => priority(a, ea.chunks.length) - priority(b, eb.chunks.length));
  const chosen = new Map<string, string>();
  for (const [rel, entry] of ordered) {
    const syms = entry.chunks
      .filter((c) => c.symbol && c.kind !== "module" && c.kind !== "window" && !c.symbol.includes("."))
      .map((c) => c.symbol!)
      .slice(0, 8);
    const line = syms.length ? `${rel}: ${syms.join(", ")}` : rel;
    const cost = estimateTokens(line) + 1;
    if (used + cost > budgetTokens) {
      omitted++;
      continue;
    }
    used += cost;
    chosen.set(rel, line);
  }
  for (const [rel] of entries) {
    const l = chosen.get(rel);
    if (l) lines.push(l);
  }
  if (omitted) lines.push(`… ${omitted} more files (use search_code / find_files)`);
  return lines.join("\n");
}
