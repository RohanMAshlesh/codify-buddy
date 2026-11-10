import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ConnectorConfigSchema, type ConnectorConfig } from "../src/config/config.js";
import { getStoredSecret, resolveCredentials, resolveSecret, saveApiKey, secretKey, setStoredSecret } from "../src/config/credentials.js";
import { adfToText, htmlToText } from "../src/connectors/convert.js";
import { repoFromRemote } from "../src/connectors/github.js";
import { getJson, type FetchLike } from "../src/connectors/http.js";
import { ConnectorManager, createConnector } from "../src/connectors/manager.js";
import { ContextIndex } from "../src/context/index.js";
import { makeTempDir } from "./helpers.js";

/** Route-based fake fetch: first matching prefix wins; records requests. */
function fakeFetch(routes: Array<[string | RegExp, unknown | ((url: string) => unknown)]>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    for (const [match, body] of routes) {
      const ok = typeof match === "string" ? url.startsWith(match) : match.test(url);
      if (!ok) continue;
      const value = typeof body === "function" ? (body as (u: string) => unknown)(url) : body;
      if (value instanceof Response) return value;
      return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  };
  return { fn, calls };
}

const cfg = (c: Record<string, unknown>) => ConnectorConfigSchema.parse(c) as ConnectorConfig;

beforeEach(() => {
  process.env.CODIFY_HOME = makeTempDir();
});

describe("converters", () => {
  it("converts Confluence storage format to readable text", () => {
    const html = `<h1>Refund Policy</h1><p>Refunds round <strong>half up</strong> &amp; never down&nbsp;.</p>
      <ac:structured-macro ac:name="code"><ac:parameter ac:name="language">ts</ac:parameter><ac:plain-text-body><![CDATA[const x = a < b;]]></ac:plain-text-body></ac:structured-macro>
      <ul><li>Stripe</li><li>Adyen</li></ul><table><tr><th>Tier</th><th>Limit</th></tr><tr><td>Gold</td><td>$500</td></tr></table>
      <p>See <a href="https://x/y">the runbook</a>.</p>`;
    const t = htmlToText(html);
    expect(t).toContain("# Refund Policy");
    expect(t).toContain("Refunds round **half up** & never down");
    expect(t).toContain("```ts\nconst x = a < b;\n```");
    expect(t).toContain("- Stripe\n- Adyen");
    expect(t).toContain("| Gold | $500 |");
    expect(t).toContain("the runbook (https://x/y)");
  });

  it("converts Atlassian Document Format", () => {
    const adf = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Steps" }] },
        { type: "paragraph", content: [{ type: "text", text: "Refund " }, { type: "mention", attrs: { text: "@ana" } }] },
        { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }] }] },
        { type: "codeBlock", attrs: { language: "sql" }, content: [{ type: "text", text: "select 1" }] },
      ],
    };
    expect(adfToText(adf)).toBe("## Steps\n\nRefund @ana\n\n- one\n\n```sql\nselect 1\n```");
    expect(adfToText("plain wiki text")).toBe("plain wiki text");
  });
});

describe("http", () => {
  it("gives actionable errors and retries 429", async () => {
    let n = 0;
    const flaky: FetchLike = async () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "0" } }) : new Response('{"ok":1}'));
    expect(await getJson(flaky, "https://x/a", { service: "Svc" })).toEqual({ ok: 1 });
    const denied: FetchLike = async () => new Response("", { status: 401 });
    await expect(getJson(denied, "https://x/a", { service: "Svc", retries: 0 })).rejects.toThrow(/rejected the credentials/);
  });
});

describe("credentials store", () => {
  it("keeps the API key and connector secrets side by side", () => {
    saveApiKey("sk-ant-1234567890abc");
    setStoredSecret(secretKey("jira", "https://acme.atlassian.net"), "jira-token");
    expect(resolveCredentials({}).apiKey).toBe("sk-ant-1234567890abc");
    expect(getStoredSecret("jira:acme.atlassian.net")).toBe("jira-token");
    expect(resolveSecret("jira", "https://acme.atlassian.net", {}, false)).toEqual({ value: "jira-token", source: "credentials file" });
    expect(resolveSecret("jira", "https://acme.atlassian.net", { JIRA_API_TOKEN: "env" }, false).source).toBe("env:JIRA_API_TOKEN");
    expect(resolveSecret("github", "https://api.github.com", {}, false)).toEqual({ source: "none" });
  });
});

describe("docs connector", () => {
  it("indexes markdown and html files from a folder", async () => {
    const root = makeTempDir({
      "wiki/runbooks/refunds.md": "# Refund Runbook\n\nRound half up.\n",
      "wiki/export/page.html": "<html><head><title>Billing FAQ</title></head><body><h2>Taxes</h2><p>VAT is included.</p></body></html>",
      "wiki/image.png": "x",
    });
    const c = createConnector(cfg({ id: "wiki", type: "docs", path: "wiki" }), { root });
    expect((await c.test()).ok).toBe(true);
    const docs = await c.sync();
    expect(docs.map((d) => d.title).sort()).toEqual(["Billing FAQ", "Refund Runbook"]);
    expect(docs.find((d) => d.title === "Billing FAQ")!.text).toContain("## Taxes");
  });
});

describe("github connector", () => {
  const issue = (n: number, extra: Record<string, unknown> = {}) => ({
    number: n, title: `Issue ${n}`, body: `Body ${n}`, state: "open", html_url: `https://github.com/acme/pay/issues/${n}`,
    updated_at: "2026-11-01T00:00:00Z", created_at: "2026-10-01T00:00:00Z", comments: 0, user: { login: "ana" }, labels: [{ name: "bug" }], ...extra,
  });

  it("syncs issues and PRs with comments, honouring filters", async () => {
    const { fn, calls } = fakeFetch([
      ["https://api.github.com/repos/acme/pay/issues/42/comments", [{ body: "Seen in prod", user: { login: "bo" }, created_at: "2026-11-02T00:00:00Z" }]],
      ["https://api.github.com/repos/acme/pay/issues?", [issue(42, { comments: 1 }), issue(43, { pull_request: { merged_at: "2026-11-03" }, title: "Fix rounding" })]],
    ]);
    const m = new ConnectorManager([cfg({ id: "github", type: "github", repo: "acme/pay" })], { root: makeTempDir(), fetch: fn, secret: () => "ghp_x" });
    const docs = await m.get("github")!.sync();
    expect(docs.map((d) => d.path)).toEqual(["issues/42", "pulls/43"]);
    expect(docs[0]!.text).toContain("**@bo** (2026-11-02):\nSeen in prod");
    expect(docs[1]!.text).toContain("Pull request #43 · merged");
    expect(calls[0]!.headers.authorization).toBe("Bearer ghp_x");

    const issuesOnly = new ConnectorManager([cfg({ id: "github", type: "github", repo: "acme/pay", pulls: false })], { root: makeTempDir(), fetch: fn, secret: () => undefined });
    expect((await issuesOnly.get("github")!.sync()).map((d) => d.path)).toEqual(["issues/42"]);
  });

  it("exposes live tools", async () => {
    const { fn, calls } = fakeFetch([
      ["https://api.github.com/repos/acme/pay/issues/43/comments", []],
      ["https://api.github.com/repos/acme/pay/issues/43", issue(43, { pull_request: {}, comments: 0 })],
      ["https://api.github.com/repos/acme/pay/pulls/43/files", [{ filename: "src/refund.ts", status: "modified", additions: 1, deletions: 1, patch: "-floor\n+round" }]],
      ["https://api.github.com/search/issues", { total_count: 1, items: [issue(42)] }],
    ]);
    const m = new ConnectorManager([cfg({ id: "github", type: "github", repo: "acme/pay" })], { root: makeTempDir(), fetch: fn, secret: () => undefined });
    const [get, search] = m.tools();
    expect(get!.name).toBe("github_get_issue");
    const out = await get!.run({ number: 43, include_diff: true }, {} as never);
    expect(out.content).toContain("### src/refund.ts (modified, +1 -1)");
    const s = await search!.run({ query: "rounding", type: "issue" }, {} as never);
    expect(s.content).toContain("#42 [issue, open] Issue 42");
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain("q=repo:acme/pay is:issue rounding");
  });

  it("parses repos from git remotes", () => {
    expect(repoFromRemote("git@github.com:acme/pay.git")).toBe("acme/pay");
    expect(repoFromRemote("https://github.com/acme/pay")).toBe("acme/pay");
    expect(repoFromRemote("https://gitlab.com/acme/pay")).toBeNull();
  });
});

describe("confluence connector", () => {
  const base = "https://acme.atlassian.net/wiki";

  it("syncs Cloud spaces with cursor pagination and basic auth", async () => {
    const { fn, calls } = fakeFetch([
      [`${base}/api/v2/spaces?keys=ENG`, { results: [{ id: "77", key: "ENG", name: "Engineering" }] }],
      [/\/api\/v2\/spaces\/77\/pages\?.*cursor=abc/, { results: [{ id: "2", title: "Deploys", body: { storage: { value: "<p>Blue/green.</p>" } }, _links: { webui: "/spaces/ENG/pages/2" } }] }],
      [`${base}/api/v2/spaces/77/pages`, {
        results: [{ id: "1", title: "Refund Policy", body: { storage: { value: "<h2>Rounding</h2><p>Half up.</p>" } }, version: { createdAt: "2026-10-10" }, _links: { webui: "/spaces/ENG/pages/1" } }],
        _links: { next: "/wiki/api/v2/spaces/77/pages?cursor=abc" },
      }],
    ]);
    const c = createConnector(cfg({ id: "confluence", type: "confluence", baseUrl: base, email: "me@acme.com", spaces: ["ENG"] }), { root: "/", fetch: fn, secret: () => "tok" });
    expect(await c.test()).toEqual({ ok: true, detail: "spaces: ENG (Engineering)" });
    const docs = await c.sync();
    expect(docs.map((d) => d.title)).toEqual(["Refund Policy", "Deploys"]);
    expect(docs[0]!.url).toBe(`${base}/spaces/ENG/pages/1`);
    expect(docs[0]!.text).toContain("## Rounding\n\nHalf up.");
    expect(calls[0]!.headers.authorization).toBe("Basic " + Buffer.from("me@acme.com:tok").toString("base64"));
  });

  it("supports Data Center with a bearer token and live CQL search", async () => {
    const dc = "https://confluence.acme.com";
    const { fn, calls } = fakeFetch([
      [`${dc}/rest/api/content/search`, { results: [{ content: { id: "9", title: "Refunds", _links: { webui: "/display/ENG/Refunds" } }, excerpt: "round @@@hl@@@half@@@endhl@@@ up" }] }],
      [`${dc}/rest/api/content?spaceKey=ENG`, { results: [{ id: "9", title: "Refunds", body: { storage: { value: "<p>x</p>" } }, _links: { webui: "/display/ENG/Refunds" } }], size: 1 }],
    ]);
    const c = createConnector(cfg({ id: "confluence", type: "confluence", baseUrl: dc, flavor: "datacenter", spaces: ["ENG"] }), { root: "/", fetch: fn, secret: () => "pat" });
    expect((await c.sync())[0]!.url).toBe(`${dc}/display/ENG/Refunds`);
    expect(calls[0]!.headers.authorization).toBe("Bearer pat");
    const out = await c.tools()[0]!.run({ query: "refund rounding" }, {} as never);
    expect(out.content).toContain("Refunds (id 9) https://confluence.acme.com/display/ENG/Refunds\n  round half up");
    expect(decodeURIComponent(calls.at(-1)!.url)).toContain('text ~ "refund rounding" AND space in ("ENG")');
  });
});

describe("jira connector", () => {
  const base = "https://acme.atlassian.net";
  const issue = { key: "PAY-7", fields: { summary: "Refund off by a cent", status: { name: "Open" }, description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Customer got 9.99" }] }] }, updated: "2026-11-05T00:00:00Z" } };

  it("syncs with JQL using token pagination", async () => {
    const { fn } = fakeFetch([
      [/search\/jql\?.*nextPageToken=t2/, { issues: [{ ...issue, key: "PAY-8" }] }],
      [`${base}/rest/api/3/search/jql`, { issues: [issue], nextPageToken: "t2" }],
      [`${base}/rest/api/3/myself`, { displayName: "Ana" }],
    ]);
    const c = createConnector(cfg({ id: "jira", type: "jira", baseUrl: base, email: "a@acme.com", jql: "project = PAY" }), { root: "/", fetch: fn, secret: () => "t" });
    expect((await c.test()).detail).toContain("signed in as Ana");
    const docs = await c.sync();
    expect(docs.map((d) => d.id)).toEqual(["PAY-7", "PAY-8"]);
    expect(docs[0]!.text).toContain("# PAY-7 Refund off by a cent\nOpen");
    expect(docs[0]!.text).toContain("Customer got 9.99");
    expect(docs[0]!.url).toBe(`${base}/browse/PAY-7`);
  });

  it("returns no documents without sync JQL but still offers live tools", async () => {
    const c = createConnector(cfg({ id: "jira", type: "jira", baseUrl: base, email: "a@x" }), { root: "/", fetch: fakeFetch([]).fn, secret: () => "t" });
    expect(await c.sync()).toEqual([]);
    expect(c.tools().map((t) => t.name)).toEqual(["jira_search", "jira_get_issue"]);
  });
});

describe("ConnectorManager", () => {
  it("syncs into the index so search_context can find documents", async () => {
    const root = makeTempDir({ "notes/adr-001.md": "# ADR 001: Use Postgres\n\nWe chose Postgres for ledgers.\n" });
    const index = new ContextIndex(root, { maxFileBytes: 1_000_000 });
    index.update();
    const m = new ConnectorManager([cfg({ id: "adrs", type: "docs", path: "notes", label: "Architecture decisions" })], { root });
    const summary = await m.sync(index, "adrs");
    expect(summary).toMatchObject({ id: "adrs", docs: 1, label: "Architecture decisions" });
    expect(index.search("why postgres for ledgers", { scope: "docs" }).hits[0]!.citation).toMatch(/^@adrs\/adr-001:/);
    expect(m.status(index)[0]!.synced?.docs).toBe(1);
    expect(fs.existsSync(path.join(root, ".codify/connectors/adrs.json"))).toBe(true);
    await expect(m.sync(index, "nope")).rejects.toThrow(/No connector/);
  });

  it("validates connector config", () => {
    expect(() => ConnectorConfigSchema.parse({ id: "Bad Id", type: "docs", path: "x" })).toThrow();
    expect(() => ConnectorConfigSchema.parse({ id: "gh", type: "github", repo: "nope" })).toThrow();
  });
});
