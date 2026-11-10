import { splitLines } from "../util/tokens.js";
import { CODE_LANGS } from "./languages.js";

export type ChunkKind = "function" | "class" | "type" | "method" | "section" | "module" | "window";

export interface Chunk {
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  /** Qualified symbol name, e.g. `UserService.findById`, or a markdown heading. */
  symbol?: string;
  text: string;
}

interface SymbolStart {
  line: number; // 0-based
  name: string;
  kind: ChunkKind;
  indent: number;
}

type Matcher = { re: RegExp; kind: ChunkKind; name: number };

const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "try", "with", "new", "typeof"]);

const PATTERNS: Record<string, Matcher[]> = {
  typescript: [
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: "function", name: 1 },
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", name: 1 },
    { re: /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|enum|type)\s+([A-Za-z_$][\w$]*)/, kind: "type", name: 1 },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, kind: "function", name: 1 },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function/, kind: "function", name: 1 },
    { re: /^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{;]+)?\{\s*$/, kind: "method", name: 1 },
  ],
  python: [
    { re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function", name: 2 },
    { re: /^(\s*)class\s+([A-Za-z_]\w*)/, kind: "class", name: 2 },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function", name: 1 },
    { re: /^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, kind: "type", name: 1 },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function", name: 1 },
    { re: /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/, kind: "type", name: 1 },
    { re: /^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/, kind: "class", name: 1 },
  ],
  jvm: [
    { re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial)\s+)*(?:class|interface|enum|record|object|struct)\s+([A-Za-z_]\w*)/, kind: "class", name: 1 },
    { re: /^\s*(?:(?:public|private|protected|internal|override|suspend|inline|open)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, kind: "function", name: 1 },
    { re: /^\s+(?:(?:public|private|protected|internal|static|final|abstract|synchronized|override|async|virtual)\s+)+[\w<>\[\],.?\s]+?\s+([A-Za-z_]\w*)\s*\(/, kind: "method", name: 1 },
    { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: "function", name: 1 },
  ],
  ruby: [
    { re: /^\s*def\s+(?:self\.)?([\w?!=]+)/, kind: "function", name: 1 },
    { re: /^\s*(?:class|module)\s+([A-Z][\w:]*)/, kind: "class", name: 1 },
  ],
  php: [
    { re: /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/, kind: "function", name: 1 },
    { re: /^\s*(?:(?:final|abstract)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/, kind: "class", name: 1 },
  ],
  c: [
    { re: /^(?:static\s+|inline\s+|extern\s+)*[A-Za-z_][\w\s\*&:<>,]*?[\s\*&]([A-Za-z_][\w:~]*)\s*\([^;]*$/, kind: "function", name: 1 },
    { re: /^\s*(?:typedef\s+)?(?:struct|class|enum|union)\s+([A-Za-z_]\w*)\s*(?:[:{]|$)/, kind: "type", name: 1 },
  ],
};

const LANG_FAMILY: Record<string, string> = {
  typescript: "typescript", javascript: "typescript", python: "python", go: "go", rust: "rust",
  java: "jvm", kotlin: "jvm", scala: "jvm", csharp: "jvm", swift: "jvm",
  ruby: "ruby", php: "php", c: "c", cpp: "c",
};

const MAX_LINES = 150;
const WINDOW = 80;
const OVERLAP = 10;

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/)![0];
  return m.replace(/\t/g, "    ").length;
}

export function findSymbols(lines: string[], language: string): SymbolStart[] {
  const family = LANG_FAMILY[language];
  const matchers = family ? PATTERNS[family]! : [];
  const out: SymbolStart[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("*")) continue;
    for (const m of matchers) {
      const hit = line.match(m.re);
      if (!hit) continue;
      const name = hit[m.name];
      if (!name || CONTROL.has(name)) continue;
      out.push({ line: i, name, kind: m.kind, indent: indentOf(line) });
      break;
    }
  }
  return out;
}

/** Attach leading comments/decorators to the symbol that follows them. */
function leadingStart(lines: string[], line: number, floor: number): number {
  let i = line;
  while (i - 1 > floor) {
    const t = lines[i - 1]!.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/**") || t.startsWith("#") || t.startsWith("@") || t.startsWith("///")) i--;
    else break;
  }
  return i;
}

function windows(lines: string[], from: number, to: number, base: Omit<Chunk, "startLine" | "endLine" | "text">): Chunk[] {
  const out: Chunk[] = [];
  for (let s = from; s <= to; s += WINDOW - OVERLAP) {
    const e = Math.min(to, s + WINDOW - 1);
    out.push({ ...base, startLine: s + 1, endLine: e + 1, text: lines.slice(s, e + 1).join("\n") });
    if (e === to) break;
  }
  return out;
}

function pushRegion(out: Chunk[], lines: string[], from: number, to: number, base: Omit<Chunk, "startLine" | "endLine" | "text">) {
  if (to < from) return;
  const text = lines.slice(from, to + 1).join("\n");
  if (!text.trim()) return;
  if (to - from + 1 > MAX_LINES) out.push(...windows(lines, from, to, base));
  else out.push({ ...base, startLine: from + 1, endLine: to + 1, text });
}

function chunkMarkdown(lines: string[]): Chunk[] {
  const heads: { line: number; title: string; level: number }[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    const m = !inFence && l.match(/^(#{1,6})\s+(.*)$/);
    if (m) heads.push({ line: i, title: m[2]!.trim(), level: m[1]!.length });
  });
  const out: Chunk[] = [];
  if (heads.length === 0 || heads[0]!.line > 0) {
    pushRegion(out, lines, 0, (heads[0]?.line ?? lines.length) - 1, { kind: "section" });
  }
  const trail: string[] = [];
  heads.forEach((h, idx) => {
    trail.length = h.level - 1;
    trail[h.level - 1] = h.title;
    const end = (heads[idx + 1]?.line ?? lines.length) - 1;
    pushRegion(out, lines, h.line, end, { kind: "section", symbol: trail.filter(Boolean).join(" > ") });
  });
  return out;
}

/** Split a file into retrieval chunks aligned to symbols where possible. */
export function chunkFile(content: string, language: string): Chunk[] {
  const lines = splitLines(content);
  if (language === "markdown") return chunkMarkdown(lines);
  if (!CODE_LANGS.has(language)) return windows(lines, 0, lines.length - 1, { kind: "window" }).filter((c) => c.text.trim());

  const syms = findSymbols(lines, language);
  if (syms.length === 0) return windows(lines, 0, lines.length - 1, { kind: "window" }).filter((c) => c.text.trim());

  // Qualify nested symbols with their container (Class.method).
  const stack: SymbolStart[] = [];
  const qualified = syms.map((s) => {
    while (stack.length && stack[stack.length - 1]!.indent >= s.indent) stack.pop();
    const parent = stack[stack.length - 1];
    const name = parent && (parent.kind === "class" || parent.kind === "type") ? `${parent.name}.${s.name}` : s.name;
    const kind: ChunkKind = parent && s.kind === "function" && parent.kind === "class" ? "method" : s.kind;
    stack.push(s);
    return { ...s, name, kind };
  });

  const out: Chunk[] = [];
  const starts = qualified.map((s, i) => leadingStart(lines, s.line, i === 0 ? -1 : qualified[i - 1]!.line));
  pushRegion(out, lines, 0, starts[0]! - 1, { kind: "module", symbol: "(module header)" });
  qualified.forEach((s, i) => {
    const end = (starts[i + 1] ?? lines.length) - 1;
    pushRegion(out, lines, starts[i]!, end, { kind: s.kind, symbol: s.name });
  });

  // Merge tiny symbol-less fragments into their predecessor to avoid noise.
  const merged: Chunk[] = [];
  for (const c of out) {
    const prev = merged[merged.length - 1];
    const lines = c.endLine - c.startLine + 1;
    if (prev && !c.symbol && lines < 3 && prev.endLine + 1 === c.startLine && prev.endLine - prev.startLine < MAX_LINES) {
      prev.endLine = c.endLine;
      prev.text += "\n" + c.text;
    } else merged.push(c);
  }
  return merged;
}
