import path from "node:path";

/** Extract raw import specifiers from source text. */
export function extractImports(content: string, language: string): string[] {
  const out = new Set<string>();
  const add = (re: RegExp, group = 1) => {
    for (const m of content.matchAll(re)) if (m[group]) out.add(m[group]!);
  };
  switch (language) {
    case "typescript":
    case "javascript":
      add(/\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g);
      add(/\bexport\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g);
      add(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g);
      add(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g);
      break;
    case "python":
      add(/^\s*from\s+([.\w]+)\s+import\b/gm);
      add(/^\s*import\s+([.\w]+)/gm);
      break;
    case "go":
      add(/^\s*import\s+"([^"]+)"/gm);
      for (const block of content.matchAll(/import\s*\(([\s\S]*?)\)/g)) {
        for (const m of block[1]!.matchAll(/"([^"]+)"/g)) out.add(m[1]!);
      }
      break;
    case "java":
    case "kotlin":
    case "scala":
      add(/^\s*import\s+(?:static\s+)?([\w.]+)/gm);
      break;
    case "rust":
      add(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm);
      add(/^\s*use\s+(crate::[\w:]+)/gm);
      break;
  }
  return [...out];
}

const JS_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * Resolve an import specifier from `fromRel` to a project file, if it points
 * inside the project. `files` is the set of indexed POSIX paths.
 */
export function resolveImport(spec: string, fromRel: string, language: string, files: Set<string>): string | null {
  const dir = path.posix.dirname(fromRel);
  const tryCandidates = (cands: string[]) => cands.find((c) => files.has(c)) ?? null;

  if (language === "typescript" || language === "javascript") {
    if (!spec.startsWith(".")) return null;
    const base = path.posix.normalize(path.posix.join(dir, spec));
    const noExt = base.replace(/\.(js|mjs|cjs|jsx)$/, "");
    return tryCandidates([
      base,
      ...JS_EXTS.map((e) => noExt + e),
      ...JS_EXTS.map((e) => `${base}/index${e}`),
    ]);
  }
  if (language === "python") {
    let rel: string;
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)![0].length;
      let d = dir;
      for (let i = 1; i < dots; i++) d = path.posix.dirname(d);
      rel = path.posix.join(d, spec.slice(dots).replace(/\./g, "/"));
    } else {
      rel = spec.replace(/\./g, "/");
    }
    return tryCandidates([`${rel}.py`, `${rel}/__init__.py`, `src/${rel}.py`, `src/${rel}/__init__.py`]);
  }
  if (language === "rust") {
    if (spec.startsWith("crate::")) {
      const parts = spec.slice(7).split("::");
      for (let n = parts.length; n > 0; n--) {
        const p = parts.slice(0, n).join("/");
        const hit = tryCandidates([`src/${p}.rs`, `src/${p}/mod.rs`]);
        if (hit) return hit;
      }
      return null;
    }
    return tryCandidates([path.posix.join(dir, `${spec}.rs`), path.posix.join(dir, spec, "mod.rs")]);
  }
  if (language === "java" || language === "kotlin" || language === "scala") {
    const p = spec.replace(/\./g, "/");
    const ext = language === "java" ? ".java" : language === "kotlin" ? ".kt" : ".scala";
    for (const f of files) if (f.endsWith(`/${p}${ext}`) || f === `${p}${ext}`) return f;
    return null;
  }
  if (language === "go") {
    // Match the import path suffix against a project directory.
    for (const f of files) {
      if (f.endsWith(".go") && path.posix.dirname(f) !== "." && spec.endsWith(path.posix.dirname(f))) return f;
    }
    return null;
  }
  return null;
}
