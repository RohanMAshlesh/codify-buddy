/**
 * Safe, dependency-free Markdown subset for the chat view: headings, bold,
 * italics, inline code, fenced code, lists, links and clickable citations.
 * Everything is HTML-escaped first; only tags generated here reach the DOM.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Citations the engine emits: `src/a.ts:10-20`, `src/a.ts:7`, `@confluence/eng/refund-policy:9-17`,
 * and bare `@source/doc` URIs.
 */
export const CITATION_RE = /(@[a-z0-9][a-z0-9-]*\/[\w./-]*[\w/](?::\d+(?:-\d+)?)?|(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+:\d+(?:-\d+)?)/g;

export interface Citation {
  path: string;
  startLine?: number;
  endLine?: number;
}

export function parseCitation(target: string): Citation | null {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(target.trim());
  if (!m) return null;
  const path = m[1]!;
  if (!path.startsWith("@") && !/\.[A-Za-z0-9]+$/.test(path)) return null;
  const startLine = m[2] ? Number(m[2]) : undefined;
  const endLine = m[3] ? Number(m[3]) : startLine;
  return { path, startLine, endLine };
}

function citeLink(target: string): string {
  return `<a class="cite" href="#" data-cite="${escapeHtml(target)}">${escapeHtml(target)}</a>`;
}

/** Turn citations inside already-escaped text into links. */
function linkifyEscaped(escaped: string): string {
  return escaped.replace(CITATION_RE, (m) => citeLink(m));
}

function inline(raw: string): string {
  // Split out inline code first so its content is not formatted further.
  const parts = raw.split(/(`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
        const code = part.slice(1, -1);
        CITATION_RE.lastIndex = 0;
        const whole = code.match(CITATION_RE);
        if (whole && whole[0] === code) return `<code>${citeLink(code)}</code>`;
        return `<code>${escapeHtml(code)}</code>`;
      }
      let s = escapeHtml(part);
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => `<a class="ext" href="#" data-href="${url}">${text}</a>`);
      s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
      // Linkify citations outside of generated tags.
      return s
        .split(/(<[^>]+>)/g)
        .map((seg) => (seg.startsWith("<") ? seg : linkifyEscaped(seg)))
        .join("");
    })
    .join("");
}

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushPara();
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence (or end of a still-streaming block)
      const lang = fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : "";
      out.push(`<pre${lang}><code>${escapeHtml(body.join("\n").replace(/\n+$/, ""))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(heading[1]!.length + 2, 6);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`);
      i++;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      closeList();
      i++;
      continue;
    }
    closeList();
    para.push(line);
    i++;
  }
  flushPara();
  closeList();
  return out.join("");
}

/** Colour a unified diff for display. */
export function renderDiff(diff: string, maxLines = 80): string {
  const lines = diff.split("\n");
  const shown = lines.slice(0, maxLines).map((l) => {
    const cls = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "ctx";
    return `<span class="${cls}">${escapeHtml(l) || " "}</span>`;
  });
  if (lines.length > maxLines) shown.push(`<span class="ctx">… ${lines.length - maxLines} more lines</span>`);
  return `<pre class="diff">${shown.join("\n")}</pre>`;
}
