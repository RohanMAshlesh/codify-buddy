const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", middot: "·",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Convert HTML / Confluence storage format to readable Markdown-ish text.
 * Keeps headings, lists, code blocks and table rows; drops styling and macros
 * except the text inside code and panel macros.
 */
export function htmlToText(html: string): string {
  // Code is set aside behind placeholders so tag stripping can't mangle it.
  const blocks: string[] = [];
  const keep = (lang: string, body: string) => `\n\u0000${blocks.push(`\`\`\`${lang}\n${body.replace(/^\n+|\n+$/g, "")}\n\`\`\``) - 1}\u0000\n`;
  let s = html;
  // Confluence code macro: the CDATA body is raw text.
  s = s.replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_m, inner: string) => {
    const lang = /<ac:parameter[^>]*ac:name="language"[^>]*>([^<]*)<\/ac:parameter>/i.exec(inner)?.[1] ?? "";
    return keep(lang, /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(inner)?.[1] ?? "");
  });
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) => keep("", decodeEntities(body.replace(/<[^>]+>/g, ""))));
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`);
  s = s.replace(/<li[^>]*>/gi, "\n- ");
  s = s.replace(/<\/(p|div|ul|ol|table|blockquote|section)>/gi, "\n\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/tr>/gi, " |\n");
  s = s.replace(/<t[hd][^>]*>/gi, "| ");
  s = s.replace(/<\/t[hd]>/gi, " ");
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => {
    const text = t.replace(/<[^>]+>/g, "").trim();
    return text && text !== href ? `${text} (${href})` : href;
  });
  s = s.replace(/<ri:page[^>]*ri:content-title="([^"]+)"[^>]*\/?>/gi, "$1");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]!);
}

interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

/** Convert Atlassian Document Format (Jira Cloud v3) to Markdown-ish text. */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return typeof node === "string" ? node : "";
  const walk = (n: AdfNode, depth = 0): string => {
    const kids = (n.content ?? []).map((c) => walk(c, depth + 1)).join("");
    switch (n.type) {
      case "text":
        return n.text ?? "";
      case "hardBreak":
        return "\n";
      case "mention":
        return String(n.attrs?.text ?? "@user");
      case "emoji":
        return String(n.attrs?.text ?? n.attrs?.shortName ?? "");
      case "inlineCard":
        return String(n.attrs?.url ?? "");
      case "paragraph":
        return kids + "\n\n";
      case "heading":
        return `${"#".repeat(Number(n.attrs?.level ?? 2))} ${kids}\n\n`;
      case "bulletList":
      case "orderedList":
        return kids + "\n";
      case "listItem":
        return `- ${kids.trim()}\n`;
      case "codeBlock":
        return `\`\`\`${String(n.attrs?.language ?? "")}\n${kids}\n\`\`\`\n\n`;
      case "blockquote":
        return kids.split("\n").map((l) => (l ? `> ${l}` : l)).join("\n");
      case "tableRow":
        return "| " + (n.content ?? []).map((c) => walk(c).trim()).join(" | ") + " |\n";
      default:
        return kids;
    }
  };
  return walk(node as AdfNode).replace(/\n{3,}/g, "\n\n").trim();
}
