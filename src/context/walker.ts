import fs from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";

/** Always skipped, regardless of ignore files. */
export const DEFAULT_IGNORES = [
  ".git/", ".codify/", "node_modules/", "dist/", "build/", "out/", "target/", "coverage/",
  ".next/", ".nuxt/", ".venv/", "venv/", "__pycache__/", ".mypy_cache/", ".pytest_cache/",
  ".idea/", ".vscode/", ".gradle/", "vendor/", "*.min.js", "*.min.css", "*.map",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "Cargo.lock", "poetry.lock",
  "*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico", "*.pdf", "*.zip", "*.gz", "*.tar",
  "*.woff", "*.woff2", "*.ttf", "*.eot", "*.mp4", "*.mp3", "*.wasm", "*.so", "*.dylib", "*.dll", "*.exe",
];

export interface WalkOptions {
  maxFileBytes: number;
  extraIgnore?: string[];
}

export interface WalkedFile {
  /** POSIX path relative to root. */
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

interface Layer {
  base: string; // POSIX rel dir ("" for root)
  ig: Ignore;
}

function loadIgnoreFile(file: string): string[] | null {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return null;
  }
}

function isIgnored(layers: Layer[], rel: string, isDir: boolean): boolean {
  const target = isDir ? rel + "/" : rel;
  for (const layer of layers) {
    const sub = layer.base ? (target.startsWith(layer.base + "/") ? target.slice(layer.base.length + 1) : null) : target;
    if (sub && layer.ig.ignores(sub)) return true;
  }
  return false;
}

/** Heuristic binary check: a NUL byte in the first 8 KB. */
export function looksBinary(abs: string): boolean {
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walk the project, honouring `.gitignore` files at every level plus
 * `.codifyignore`, built-in ignores and size/binary limits.
 */
export function walkProject(root: string, opts: WalkOptions): WalkedFile[] {
  const rootIg = ignore().add(DEFAULT_IGNORES).add(opts.extraIgnore ?? []);
  const codifyIgnore = loadIgnoreFile(path.join(root, ".codifyignore"));
  if (codifyIgnore) rootIg.add(codifyIgnore);
  const out: WalkedFile[] = [];

  const visit = (absDir: string, relDir: string, layers: Layer[]) => {
    const gi = loadIgnoreFile(path.join(absDir, ".gitignore"));
    const here = gi ? [...layers, { base: relDir, ig: ignore().add(gi) }] : layers;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const abs = path.join(absDir, e.name);
      if (e.isSymbolicLink()) continue; // never follow links out of the project
      if (e.isDirectory()) {
        if (!isIgnored(here, rel, true)) visit(abs, rel, here);
      } else if (e.isFile()) {
        if (isIgnored(here, rel, false)) continue;
        const st = fs.statSync(abs);
        if (st.size === 0 || st.size > opts.maxFileBytes) continue;
        if (looksBinary(abs)) continue;
        out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };

  visit(root, "", [{ base: "", ig: rootIg }]);
  return out;
}
