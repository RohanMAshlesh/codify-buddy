const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "be", "with", "as",
  "at", "by", "it", "this", "that", "from", "how", "what", "where", "which", "does", "do", "we",
  "i", "you", "can", "if", "else", "return", "const", "let", "var", "new", "import", "export",
  "function", "def", "class", "public", "private", "static", "void", "true", "false", "null",
  "undefined", "none", "self", "end", "then", "not", "use",
]);

/** Split an identifier into its parts: `getUserById` → get, user, by, id. */
export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/**
 * Tokenise code or prose for BM25. Emits identifier parts and, for compound
 * identifiers, the whole identifier too so exact names score highest.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[A-Za-z_$][A-Za-z0-9_$]*|\d+/g) ?? []) {
    const parts = splitIdentifier(raw);
    if (parts.length > 1) {
      const whole = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (whole.length > 2) out.push(whole);
    }
    for (const p of parts) {
      if (p.length < 2 || STOPWORDS.has(p)) continue;
      out.push(stem(p));
    }
  }
  return out;
}

/** Very light stemming: plurals and common verb endings. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function termFrequencies(tokens: string[]): Record<string, number> {
  // Null prototype: tokens like "constructor" must not hit Object.prototype.
  const tf: Record<string, number> = Object.create(null);
  for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
  return tf;
}
