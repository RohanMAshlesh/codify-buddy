import { describe, expect, it } from "vitest";
import { escapeHtml, parseCitation, renderDiff, renderMarkdown } from "../src/webview/render.js";

describe("renderMarkdown", () => {
  it("escapes HTML so model output can't inject markup", () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)"> **bold**');
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("renders headings, lists, code fences and inline code", () => {
    const html = renderMarkdown("## Fix\n\n- one\n- two\n\n1. a\n2. b\n\n```ts\nconst x = a < b;\n```\nUse `npm test`.");
    expect(html).toContain("<h4>Fix</h4>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html).toContain("<ol><li>a</li><li>b</li></ol>");
    expect(html).toContain('<pre data-lang="ts"><code>const x = a &lt; b;</code></pre>');
    expect(html).toContain("<code>npm test</code>");
  });

  it("does not format inside code fences, even unterminated ones while streaming", () => {
    const html = renderMarkdown("```\n**not bold** src/a.ts:1\n");
    expect(html).toBe("<pre><code>**not bold** src/a.ts:1</code></pre>");
  });

  it("turns citations into links, in text and in inline code", () => {
    const html = renderMarkdown("Root cause at `src/refunds.js:25`; policy in `@confluence/refund-policy:9-17` and src/money.js:3-5.");
    expect(html).toContain('<code><a class="cite" href="#" data-cite="src/refunds.js:25">src/refunds.js:25</a></code>');
    expect(html).toContain('data-cite="@confluence/refund-policy:9-17"');
    expect(html).toContain('data-cite="src/money.js:3-5"');
  });

  it("renders http links without making them live hrefs", () => {
    const html = renderMarkdown("See [the runbook](https://wiki.acme.com/x).");
    expect(html).toContain('<a class="ext" href="#" data-href="https://wiki.acme.com/x">the runbook</a>');
  });
});

describe("parseCitation", () => {
  it("parses files, ranges and documents", () => {
    expect(parseCitation("src/a.ts:10-20")).toEqual({ path: "src/a.ts", startLine: 10, endLine: 20 });
    expect(parseCitation("src/a.ts:7")).toEqual({ path: "src/a.ts", startLine: 7, endLine: 7 });
    expect(parseCitation("@github/issues/42")).toEqual({ path: "@github/issues/42", startLine: undefined, endLine: undefined });
    expect(parseCitation("not a path")).toBeNull();
  });
});

describe("renderDiff", () => {
  it("colours lines and escapes them", () => {
    const html = renderDiff("@@ -1 +1 @@\n-a < b\n+a <= b\n ctx");
    expect(html).toContain('<span class="del">-a &lt; b</span>');
    expect(html).toContain('<span class="add">+a &lt;= b</span>');
    expect(html).toContain('<span class="hunk">@@ -1 +1 @@</span>');
    expect(escapeHtml(`"'`)).toBe("&quot;&#39;");
  });
});
