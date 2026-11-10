import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { walkProject } from "../context/walker.js";
import { lineDiff } from "../util/diff.js";
import { resolveInRoot, toRel } from "../util/paths.js";
import { splitLines, truncateMiddle } from "../util/tokens.js";
import { ToolError, type Tool, type ToolContext, type ToolOutput } from "./types.js";

const MAX_READ_LINES = 2000;
const MAX_OUTPUT_TOKENS = 25_000;

function numbered(lines: string[], start: number): string {
  const width = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join("\n");
}

function readText(abs: string, rel: string): string {
  if (!fs.existsSync(abs)) throw new ToolError(`File not found: ${rel}`);
  if (fs.statSync(abs).isDirectory()) throw new ToolError(`${rel} is a directory; use list_dir`);
  return fs.readFileSync(abs, "utf8");
}

function readExternal(input: { path: string; start_line?: number; end_line?: number }, ctx: ToolContext): ToolOutput {
  const doc = ctx.index.getExternalDoc(input.path);
  if (!doc) throw new ToolError(`No connected document at ${input.path}. Use search_context with scope "docs" to find documents.`);
  const lines = splitLines(doc.text);
  const start = Math.max(1, input.start_line ?? 1);
  const end = Math.min(lines.length, input.end_line ?? start + MAX_READ_LINES - 1);
  const header = `# ${doc.title}\nsource: ${doc.sourceLabel}${doc.url ? `\nurl: ${doc.url}` : ""}${doc.updatedAt ? `\nupdated: ${doc.updatedAt}` : ""}\n\n`;
  const body = truncateMiddle(numbered(lines.slice(start - 1, end), start), MAX_OUTPUT_TOKENS);
  return { content: header + body, summary: `Read ${doc.title} (${doc.sourceLabel})` };
}

export const readFileTool: Tool<{ path: string; start_line?: number; end_line?: number }> = {
  name: "read_file",
  description:
    "Read a text file from the project, or a connected document by its @source/... URI (from search_context). Returns numbered lines. Use start_line/end_line for large files (max 2000 lines per call).",
  access: "read",
  schema: z.object({
    path: z.string().describe("Path relative to the project root, or an @source/... document URI"),
    start_line: z.number().int().positive().optional().describe("1-based first line"),
    end_line: z.number().int().positive().optional().describe("1-based last line, inclusive"),
  }),
  describe: (i) => `read ${i.path}`,
  async run(input, ctx) {
    if (input.path.startsWith("@")) return readExternal(input, ctx);
    const abs = resolveInRoot(ctx.root, input.path);
    const lines = splitLines(readText(abs, input.path));
    const start = Math.max(1, input.start_line ?? 1);
    const end = Math.min(lines.length, input.end_line ?? start + MAX_READ_LINES - 1, start + MAX_READ_LINES - 1);
    if (start > lines.length) throw new ToolError(`start_line ${start} is past end of file (${lines.length} lines)`);
    let body = numbered(lines.slice(start - 1, end), start);
    body = truncateMiddle(body, MAX_OUTPUT_TOKENS);
    const more = end < lines.length ? `\n\n[showing lines ${start}-${end} of ${lines.length}; read more with start_line=${end + 1}]` : "";
    return { content: body + more, summary: `Read ${toRel(ctx.root, abs)} (${start}-${end} of ${lines.length})` };
  },
};

export const listDirTool: Tool<{ path?: string; depth?: number }> = {
  name: "list_dir",
  description: "List files and directories (respects .gitignore). depth defaults to 2.",
  access: "read",
  schema: z.object({
    path: z.string().optional().describe("Directory relative to project root; default root"),
    depth: z.number().int().min(1).max(6).optional(),
  }),
  describe: (i) => `list ${i.path ?? "."}`,
  async run(input, ctx) {
    const abs = resolveInRoot(ctx.root, input.path ?? ".");
    const base = toRel(ctx.root, abs);
    const depth = input.depth ?? 2;
    const files = walkProject(ctx.root, ctx.config.context).map((f) => f.rel);
    const entries = new Set<string>();
    for (const f of files) {
      if (base && !f.startsWith(base + "/")) continue;
      const rest = base ? f.slice(base.length + 1) : f;
      const parts = rest.split("/");
      for (let d = 1; d <= Math.min(depth, parts.length); d++) {
        const isDir = d < parts.length;
        entries.add(parts.slice(0, d).join("/") + (isDir ? "/" : ""));
      }
    }
    const list = [...entries].sort();
    const shown = list.slice(0, 500);
    const tail = list.length > shown.length ? `\n… ${list.length - shown.length} more entries` : "";
    return { content: (shown.join("\n") || "(empty)") + tail, summary: `Listed ${base || "."} (${list.length} entries)` };
  },
};

export const findFilesTool: Tool<{ query: string }> = {
  name: "find_files",
  description: "Find indexed files whose path contains all the given space-separated fragments, e.g. 'auth middleware'.",
  access: "read",
  schema: z.object({ query: z.string().min(1) }),
  describe: (i) => `find files "${i.query}"`,
  async run(input, ctx) {
    const hits = ctx.index.findFiles(input.query, 50);
    return { content: hits.join("\n") || "No matching files.", summary: `Found ${hits.length} files for "${input.query}"` };
  },
};

export const grepTool: Tool<{ pattern: string; path?: string; ignore_case?: boolean; max_results?: number }> = {
  name: "grep",
  description:
    "Search file contents with a JavaScript regular expression. Returns path:line: text matches. Prefer search_context for conceptual queries; use grep for exact strings.",
  access: "read",
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional().describe("Limit to files under this directory or matching this path prefix"),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().positive().max(1000).optional(),
  }),
  describe: (i) => `grep /${i.pattern}/${i.path ? ` in ${i.path}` : ""}`,
  async run(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignore_case ? "i" : "");
    } catch (err) {
      throw new ToolError(`Invalid regex: ${(err as Error).message}`);
    }
    const prefix = input.path ? toRel(ctx.root, resolveInRoot(ctx.root, input.path)) : "";
    const max = input.max_results ?? 200;
    const out: string[] = [];
    for (const f of walkProject(ctx.root, ctx.config.context)) {
      if (prefix && f.rel !== prefix && !f.rel.startsWith(prefix + "/")) continue;
      const lines = fs.readFileSync(f.abs, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length && out.length < max; i++) {
        if (re.test(lines[i]!)) out.push(`${f.rel}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
      }
      if (out.length >= max) break;
    }
    const capped = out.length >= max ? `\n[stopped at ${max} matches]` : "";
    return { content: (out.join("\n") || "No matches.") + capped, summary: `grep /${input.pattern}/ → ${out.length} matches` };
  },
};

export const writeFileTool: Tool<{ path: string; content: string }> = {
  name: "write_file",
  description: "Create a new file or fully overwrite an existing one. Prefer edit_file for changes to existing files.",
  access: "write",
  schema: z.object({ path: z.string(), content: z.string() }),
  describe: (i) => `write ${i.path} (${i.content.split("\n").length} lines)`,
  async preview(input, ctx) {
    const abs = resolveInRoot(ctx.root, input.path);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    return lineDiff(before, input.content);
  },
  async proposed(input, ctx) {
    const abs = resolveInRoot(ctx.root, input.path);
    const isNew = !fs.existsSync(abs);
    return { path: toRel(ctx.root, abs), before: isNew ? "" : fs.readFileSync(abs, "utf8"), after: input.content, isNew };
  },
  async run(input, ctx) {
    const abs = resolveInRoot(ctx.root, input.path);
    const existed = fs.existsSync(abs);
    const before = existed ? fs.readFileSync(abs, "utf8") : "";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, input.content);
    const rel = toRel(ctx.root, abs);
    return {
      content: `${existed ? "Overwrote" : "Created"} ${rel}`,
      summary: `${existed ? "Overwrote" : "Created"} ${rel}`,
      diff: lineDiff(before, input.content),
    };
  },
};

function applyEdit(content: string, oldStr: string, newStr: string, replaceAll: boolean, rel: string): string {
  if (oldStr === newStr) throw new ToolError("old_string and new_string are identical");
  const count = oldStr ? content.split(oldStr).length - 1 : 0;
  if (count === 0) throw new ToolError(`old_string not found in ${rel}. Read the file again and copy the text exactly.`);
  if (count > 1 && !replaceAll) {
    throw new ToolError(`old_string occurs ${count} times in ${rel}; add surrounding context to make it unique or set replace_all.`);
  }
  return replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
}

export const editFileTool: Tool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match exactly (including whitespace) and be unique unless replace_all is true. Read the file first.",
  access: "write",
  schema: z.object({
    path: z.string(),
    old_string: z.string().min(1),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  describe: (i) => `edit ${i.path}`,
  async preview(input, ctx) {
    const abs = resolveInRoot(ctx.root, input.path);
    const before = readText(abs, input.path);
    return lineDiff(before, applyEdit(before, input.old_string, input.new_string, !!input.replace_all, input.path));
  },
  async proposed(input, ctx) {
    const abs = resolveInRoot(ctx.root, input.path);
    const before = readText(abs, input.path);
    return { path: toRel(ctx.root, abs), before, after: applyEdit(before, input.old_string, input.new_string, !!input.replace_all, input.path), isNew: false };
  },
  async run(input, ctx) {
    const abs = resolveInRoot(ctx.root, input.path);
    const before = readText(abs, input.path);
    const after = applyEdit(before, input.old_string, input.new_string, !!input.replace_all, input.path);
    fs.writeFileSync(abs, after);
    const rel = toRel(ctx.root, abs);
    return { content: `Edited ${rel}`, summary: `Edited ${rel}`, diff: lineDiff(before, after) };
  },
};
