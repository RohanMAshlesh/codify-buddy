import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, projectDir } from "../config/paths.js";
import { estimateTokens } from "../util/tokens.js";
import { chunkFile, type ChunkKind } from "./chunker.js";
import { extractImports, resolveImport } from "./graph.js";
import { languageFor } from "./languages.js";
import { splitIdentifier, stem, termFrequencies, tokenize } from "./tokenize.js";
import { walkProject } from "./walker.js";

export const INDEX_VERSION = 3;

const SYMBOL_WEIGHT = 4;
const PATH_WEIGHT = 2;
const K1 = 1.2;
const B = 0.75;
const MAX_CHUNKS_PER_FILE = 3;

export interface StoredChunk {
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  symbol?: string;
  /** Weighted term frequencies (body + symbol + path). */
  tf: Record<string, number>;
  len: number;
  tokens: number;
}

export interface FileEntry {
  hash: string;
  mtimeMs: number;
  size: number;
  language: string;
  imports: string[];
  chunks: StoredChunk[];
}

/** A document from a connector (Confluence page, issue, doc folder file). */
export interface ExternalDoc {
  id: string;
  title: string;
  /** Virtual path used in citations, e.g. `@confluence/ENG/refund-policy`. */
  uri: string;
  url?: string;
  updatedAt?: string;
  text: string;
  chunks: StoredChunk[];
}

export interface ExternalSource {
  id: string;
  kind: string;
  label: string;
  syncedAt: string;
  docs: Record<string, ExternalDoc>;
}

export interface ExternalDocInput {
  id: string;
  title: string;
  /** Path segment(s) under the source, e.g. `ENG/Refund Policy`. Defaults to the title. */
  path?: string;
  url?: string;
  updatedAt?: string;
  /** Markdown or plain text. */
  text: string;
}

export interface SourceSummary {
  id: string;
  kind: string;
  label: string;
  syncedAt: string;
  docs: number;
}

interface Persisted {
  version: number;
  builtAt: string;
  files: Record<string, FileEntry>;
}

export interface IndexOptions {
  maxFileBytes: number;
  extraIgnore?: string[];
}

export interface UpdateStats {
  files: number;
  added: number;
  changed: number;
  removed: number;
  chunks: number;
  ms: number;
}

export type SearchScope = "all" | "code" | "docs";

export interface SearchOptions {
  limit?: number;
  /** `code` = project files, `docs` = connector documents, `all` (default) = both. */
  scope?: SearchScope;
  /** Only include files whose path contains this substring or matches this glob-ish prefix. */
  pathFilter?: string;
  /** Token budget for returned snippet text. */
  budgetTokens?: number;
  /** Include snippet text (reads from disk). Default true. */
  withText?: boolean;
}

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  symbol?: string;
  score: number;
  /** `path:start-end` */
  citation: string;
  text?: string;
  /** Connector id for external documents (absent for project files). */
  source?: string;
  url?: string;
  title?: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Files directly connected (imports / imported-by) to the top hits. */
  related: string[];
  tokens: number;
}

type ChunkRef = { path: string; chunk: StoredChunk; doc?: ExternalDoc; source?: string };

/** Turn a title or path into a citation-friendly slug segment. */
export function slugify(s: string): string {
  return s
    .split("/")
    .map((seg) => seg.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "untitled")
    .join("/");
}

function hashContent(content: string): string {
  return crypto.createHash("sha1").update(content).digest("hex");
}

function pathTokens(rel: string): string[] {
  return rel.split(/[/._-]+/).flatMap(splitIdentifier).filter((t) => t.length > 1).map(stem);
}

function buildChunkTf(text: string, symbol: string | undefined, rel: string): Record<string, number> {
  const tf = termFrequencies(tokenize(text));
  if (symbol) for (const t of tokenize(symbol)) tf[t] = (tf[t] ?? 0) + SYMBOL_WEIGHT;
  for (const t of pathTokens(rel)) tf[t] = (tf[t] ?? 0) + PATH_WEIGHT;
  return tf;
}

/**
 * Local, dependency-free code index: symbol-aware chunks, BM25F-style
 * scoring, an import graph and incremental updates keyed on content hash.
 */
/**
 * Index options for a project: the context settings plus exclusions for
 * docs-connector folders inside the project, so their files are indexed once
 * (as connector documents) rather than twice.
 */
export function indexOptionsFor(root: string, config: { context: IndexOptions; connectors: Array<{ type: string; path?: string }> }): IndexOptions {
  const extra = [...(config.context.extraIgnore ?? [])];
  const absRoot = path.resolve(root);
  for (const c of config.connectors) {
    if (c.type !== "docs" || !c.path) continue;
    const rel = path.relative(absRoot, path.resolve(absRoot, c.path)).split(path.sep).join("/");
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) extra.push(`/${rel}/`);
  }
  return { ...config.context, extraIgnore: extra };
}

export class ContextIndex {
  readonly root: string;
  private files: Record<string, FileEntry> = Object.create(null);
  private external: Record<string, ExternalSource> = Object.create(null);
  private docsByUri = new Map<string, { doc: ExternalDoc; source: ExternalSource }>();
  private refs: ChunkRef[] = [];
  private postings = new Map<string, Array<[number, number]>>();
  private avgLen = 1;
  private graph = new Map<string, Set<string>>();
  builtAt: string | null = null;

  constructor(root: string, private readonly opts: IndexOptions) {
    this.root = path.resolve(root);
  }

  get indexFile(): string {
    return path.join(projectDir(this.root), "index", "index.json");
  }

  get externalDir(): string {
    return path.join(projectDir(this.root), "connectors");
  }

  get fileCount(): number {
    return Object.keys(this.files).length;
  }

  get chunkCount(): number {
    return this.refs.length;
  }

  fileEntries(): Readonly<Record<string, FileEntry>> {
    return this.files;
  }

  /** Load a persisted index if present and compatible. */
  load(): boolean {
    this.loadExternal();
    try {
      const data = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as Persisted;
      if (data.version !== INDEX_VERSION) return false;
      this.files = Object.assign(Object.create(null), data.files);
      for (const entry of Object.values(this.files)) {
        for (const c of entry.chunks) c.tf = Object.assign(Object.create(null), c.tf);
      }
      this.builtAt = data.builtAt;
      this.rebuildDerived();
      return true;
    } catch {
      this.rebuildDerived();
      return false;
    }
  }

  /** Load connector documents synced into `.codify/connectors/*.json`. */
  private loadExternal(): void {
    this.external = Object.create(null);
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.externalDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    for (const n of names) {
      try {
        const src = JSON.parse(fs.readFileSync(path.join(this.externalDir, n), "utf8")) as ExternalSource & { version?: number };
        if (src.version !== INDEX_VERSION) continue;
        src.docs = Object.assign(Object.create(null), src.docs);
        for (const d of Object.values(src.docs)) for (const c of d.chunks) c.tf = Object.assign(Object.create(null), c.tf);
        this.external[src.id] = src;
      } catch {
        // ignore unreadable source files; a re-sync rewrites them
      }
    }
  }

  /** Replace all documents of one connector source and persist them. */
  setExternalSource(input: { id: string; kind: string; label: string; docs: ExternalDocInput[] }): SourceSummary {
    const docs: Record<string, ExternalDoc> = Object.create(null);
    const usedUris = new Set<string>();
    for (const d of input.docs) {
      let uri = `@${input.id}/${slugify(d.path ?? d.title)}`;
      for (let n = 2; usedUris.has(uri); n++) uri = `@${input.id}/${slugify(d.path ?? d.title)}-${n}`;
      usedUris.add(uri);
      const chunks = chunkFile(d.text, "markdown").map((c): StoredChunk => {
        const symbol = !c.symbol ? d.title : c.symbol === d.title || c.symbol.startsWith(`${d.title} > `) ? c.symbol : `${d.title} > ${c.symbol}`;
        const tf = buildChunkTf(c.text, symbol, `${input.id}/${d.path ?? d.title}`);
        const len = Object.values(tf).reduce((a, b) => a + b, 0);
        return { startLine: c.startLine, endLine: c.endLine, kind: "section", symbol, tf, len, tokens: estimateTokens(c.text) };
      });
      docs[d.id] = { id: d.id, title: d.title, uri, url: d.url, updatedAt: d.updatedAt, text: d.text, chunks };
    }
    const src: ExternalSource = { id: input.id, kind: input.kind, label: input.label, syncedAt: new Date().toISOString(), docs };
    ensureDir(this.externalDir);
    const file = path.join(this.externalDir, `${input.id}.json`);
    fs.writeFileSync(file + ".tmp", JSON.stringify({ version: INDEX_VERSION, ...src }));
    fs.renameSync(file + ".tmp", file);
    this.external[src.id] = src;
    this.rebuildDerived();
    return this.summarize(src);
  }

  removeExternalSource(id: string): boolean {
    if (!this.external[id]) return false;
    delete this.external[id];
    try {
      fs.unlinkSync(path.join(this.externalDir, `${id}.json`));
    } catch {
      // already gone
    }
    this.rebuildDerived();
    return true;
  }

  private summarize(src: ExternalSource): SourceSummary {
    return { id: src.id, kind: src.kind, label: src.label, syncedAt: src.syncedAt, docs: Object.keys(src.docs).length };
  }

  sources(): SourceSummary[] {
    return Object.values(this.external)
      .map((s) => this.summarize(s))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Look up a connector document by its `@source/...` URI. */
  getExternalDoc(uri: string): (ExternalDoc & { source: string; sourceLabel: string }) | null {
    const hit = this.docsByUri.get(uri);
    return hit ? { ...hit.doc, source: hit.source.id, sourceLabel: hit.source.label } : null;
  }

  save(): void {
    ensureDir(path.dirname(this.indexFile));
    const data: Persisted = { version: INDEX_VERSION, builtAt: this.builtAt ?? new Date().toISOString(), files: this.files };
    const tmp = this.indexFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, this.indexFile);
    // Keep the index out of git without requiring the user to edit .gitignore.
    const gi = path.join(projectDir(this.root), ".gitignore");
    if (!fs.existsSync(gi)) fs.writeFileSync(gi, "index/\nsessions/\n");
  }

  /** Walk the project and (re)index changed files. */
  update(): UpdateStats {
    const t0 = Date.now();
    const walked = walkProject(this.root, this.opts);
    const seen = new Set<string>();
    let added = 0;
    let changed = 0;
    for (const f of walked) {
      seen.add(f.rel);
      const prev = this.files[f.rel];
      if (prev && prev.mtimeMs === f.mtimeMs && prev.size === f.size) continue;
      let content: string;
      try {
        content = fs.readFileSync(f.abs, "utf8");
      } catch {
        continue;
      }
      const hash = hashContent(content);
      if (prev && prev.hash === hash) {
        prev.mtimeMs = f.mtimeMs;
        prev.size = f.size;
        continue;
      }
      this.files[f.rel] = this.indexFileContent(f.rel, content, hash, f.mtimeMs, f.size);
      if (prev) changed++;
      else added++;
    }
    let removed = 0;
    for (const rel of Object.keys(this.files)) {
      if (!seen.has(rel)) {
        delete this.files[rel];
        removed++;
      }
    }
    if (added || changed || removed || !this.builtAt) {
      this.builtAt = new Date().toISOString();
      this.rebuildDerived();
      this.save();
    }
    return { files: walked.length, added, changed, removed, chunks: this.refs.length, ms: Date.now() - t0 };
  }

  private indexFileContent(rel: string, content: string, hash: string, mtimeMs: number, size: number): FileEntry {
    const language = languageFor(rel);
    const chunks = chunkFile(content, language).map((c): StoredChunk => {
      const tf = buildChunkTf(c.text, c.symbol, rel);
      const len = Object.values(tf).reduce((a, b) => a + b, 0);
      return { startLine: c.startLine, endLine: c.endLine, kind: c.kind, symbol: c.symbol, tf, len, tokens: estimateTokens(c.text) };
    });
    return { hash, mtimeMs, size, language, imports: extractImports(content, language), chunks };
  }

  private rebuildDerived(): void {
    this.refs = [];
    this.postings = new Map();
    let total = 0;
    for (const [rel, entry] of Object.entries(this.files)) {
      for (const chunk of entry.chunks) {
        const idx = this.refs.length;
        this.refs.push({ path: rel, chunk });
        total += chunk.len;
        for (const [term, tf] of Object.entries(chunk.tf)) {
          if (typeof tf !== "number" || !Number.isFinite(tf)) continue;
          let list = this.postings.get(term);
          if (!list) this.postings.set(term, (list = []));
          list.push([idx, tf]);
        }
      }
    }
    this.docsByUri = new Map();
    for (const src of Object.values(this.external)) {
      for (const doc of Object.values(src.docs)) {
        this.docsByUri.set(doc.uri, { doc, source: src });
        for (const chunk of doc.chunks) {
          const idx = this.refs.length;
          this.refs.push({ path: doc.uri, chunk, doc, source: src.id });
          total += chunk.len;
          for (const [term, tf] of Object.entries(chunk.tf)) {
            if (typeof tf !== "number" || !Number.isFinite(tf)) continue;
            let list = this.postings.get(term);
            if (!list) this.postings.set(term, (list = []));
            list.push([idx, tf]);
          }
        }
      }
    }
    this.avgLen = this.refs.length ? total / this.refs.length : 1;

    const all = new Set(Object.keys(this.files));
    this.graph = new Map();
    const link = (a: string, b: string) => {
      if (!this.graph.has(a)) this.graph.set(a, new Set());
      this.graph.get(a)!.add(b);
    };
    for (const [rel, entry] of Object.entries(this.files)) {
      for (const spec of entry.imports) {
        const target = resolveImport(spec, rel, entry.language, all);
        if (target && target !== rel) {
          link(rel, target);
          link(target, rel);
        }
      }
    }
  }

  /** Files that import, or are imported by, `rel`. */
  neighbours(rel: string): string[] {
    return [...(this.graph.get(rel) ?? [])].sort();
  }

  search(query: string, options: SearchOptions = {}): SearchResult {
    const limit = options.limit ?? 8;
    const budget = options.budgetTokens ?? Number.POSITIVE_INFINITY;
    const withText = options.withText ?? true;
    const qTerms = [...new Set(tokenize(query))];
    if (qTerms.length === 0 || this.refs.length === 0) return { hits: [], related: [], tokens: 0 };

    const N = this.refs.length;
    const scores = new Map<number, number>();
    for (const term of qTerms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
      for (const [idx, tf] of list) {
        const len = this.refs[idx]!.chunk.len;
        const s = (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / this.avgLen));
        scores.set(idx, (scores.get(idx) ?? 0) + s);
      }
    }

    // Boost exact identifier matches in symbol names.
    const rawIdents = (query.match(/[A-Za-z_$][\w$]{2,}/g) ?? []).map((w) => w.toLowerCase());
    const filter = options.pathFilter;
    const scope = options.scope ?? "all";
    const ranked = [...scores.entries()]
      .filter(([idx]) => {
        const ref = this.refs[idx]!;
        if (scope === "code" && ref.doc) return false;
        if (scope === "docs" && !ref.doc) return false;
        return !filter || ref.path.includes(filter);
      })
      .map(([idx, s]) => {
        const { chunk, path: p } = this.refs[idx]!;
        const sym = chunk.symbol?.toLowerCase() ?? "";
        const lastSym = sym.split(".").pop() ?? "";
        let boost = 1;
        if (rawIdents.some((w) => w === lastSym || w === sym)) boost *= 2;
        else if (sym && rawIdents.some((w) => sym.includes(w))) boost *= 1.3;
        if (rawIdents.some((w) => p.toLowerCase().includes(w))) boost *= 1.2;
        if (chunk.kind === "window") boost *= 0.9;
        return { idx, score: s * boost };
      })
      .sort((a, b) => b.score - a.score);

    const perFile = new Map<string, number>();
    const hits: SearchHit[] = [];
    let tokens = 0;
    for (const { idx, score } of ranked) {
      if (hits.length >= limit) break;
      const { path: rel, chunk, doc, source } = this.refs[idx]!;
      const n = perFile.get(rel) ?? 0;
      if (n >= MAX_CHUNKS_PER_FILE) continue;
      if (tokens + chunk.tokens > budget && hits.length > 0) continue;
      perFile.set(rel, n + 1);
      const hit: SearchHit = {
        path: rel,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        kind: chunk.kind,
        symbol: chunk.symbol,
        score: Math.round(score * 1000) / 1000,
        citation: `${rel}:${chunk.startLine}-${chunk.endLine}`,
      };
      if (doc) {
        hit.source = source;
        hit.title = doc.title;
        if (doc.url) hit.url = doc.url;
      }
      if (withText) {
        hit.text = doc
          ? doc.text.split(/\r?\n/).slice(chunk.startLine - 1, chunk.endLine).join("\n")
          : this.readLines(rel, chunk.startLine, chunk.endLine);
      }
      tokens += chunk.tokens;
      hits.push(hit);
    }

    const hitFiles = new Set(hits.map((h) => h.path));
    const related = new Set<string>();
    for (const f of [...hitFiles].slice(0, 3)) for (const nb of this.neighbours(f)) if (!hitFiles.has(nb)) related.add(nb);
    return { hits, related: [...related].slice(0, 8), tokens };
  }

  /** Find files whose path matches all whitespace-separated query parts. */
  findFiles(query: string, limit = 20): string[] {
    const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
    return Object.keys(this.files)
      .filter((f) => parts.every((p) => f.toLowerCase().includes(p)))
      .sort((a, b) => a.length - b.length)
      .slice(0, limit);
  }

  private readLines(rel: string, start: number, end: number): string {
    try {
      const lines = fs.readFileSync(path.join(this.root, rel), "utf8").split(/\r?\n/);
      return lines.slice(start - 1, end).join("\n");
    } catch {
      return "";
    }
  }
}
