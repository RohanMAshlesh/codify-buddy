import { z } from "zod";
import type { JiraConnectorSchema } from "../config/config.js";
import type { ExternalDocInput } from "../context/index.js";
import type { Tool } from "../tools/types.js";
import { truncateMiddle } from "../util/tokens.js";
import { adfToText } from "./convert.js";
import { basicAuth, getJson, trimBase, type HttpOptions } from "./http.js";
import type { Connector, ConnectorRuntime, ProgressFn } from "./types.js";

type Cfg = z.infer<typeof JiraConnectorSchema>;

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string };
    issuetype?: { name: string };
    priority?: { name: string };
    assignee?: { displayName: string } | null;
    reporter?: { displayName: string } | null;
    updated?: string;
    labels?: string[];
    comment?: { comments: Array<{ author?: { displayName: string }; created: string; body: unknown }> };
  };
}

const FIELDS = "summary,description,status,issuetype,priority,assignee,reporter,updated,labels,comment";

/** Jira Cloud (REST v3, ADF bodies) or Data Center (REST v2, wiki text). */
export class JiraConnector implements Connector {
  readonly type = "jira";
  readonly id: string;
  readonly label: string;
  private readonly base: string;

  constructor(private readonly cfg: Cfg, private readonly rt: ConnectorRuntime) {
    this.id = cfg.id;
    this.base = trimBase(cfg.baseUrl);
    this.label = cfg.label ?? `Jira ${new URL(cfg.baseUrl).host}`;
  }

  private opts(): HttpOptions {
    const token = this.rt.secret();
    const headers: Record<string, string> = {};
    if (token) headers.authorization = this.cfg.flavor === "cloud" ? basicAuth(this.cfg.email ?? "", token) : `Bearer ${token}`;
    return { service: "Jira", headers };
  }

  private get<T>(p: string): Promise<T> {
    return getJson<T>(this.rt.fetch, `${this.base}${p}`, this.opts());
  }

  private get v(): string {
    return this.cfg.flavor === "cloud" ? "3" : "2";
  }

  private text(body: unknown): string {
    return typeof body === "string" ? body : adfToText(body);
  }

  format(i: JiraIssue): string {
    const f = i.fields;
    const meta = [f.issuetype?.name, f.status?.name, f.priority?.name && `priority ${f.priority.name}`, f.assignee && `assignee ${f.assignee.displayName}`, f.labels?.length && `labels: ${f.labels.join(", ")}`, f.updated && `updated ${f.updated.slice(0, 10)}`]
      .filter(Boolean)
      .join(" · ");
    const parts = [`# ${i.key} ${f.summary}`, meta, `${this.base}/browse/${i.key}`, "", this.text(f.description).trim() || "_No description._"];
    const comments = f.comment?.comments ?? [];
    if (comments.length) {
      parts.push("", "## Comments");
      for (const c of comments.slice(-20)) parts.push("", `**${c.author?.displayName ?? "unknown"}** (${c.created.slice(0, 10)}):`, this.text(c.body).trim());
    }
    return parts.join("\n");
  }

  async search(jql: string, max: number, progress?: ProgressFn): Promise<JiraIssue[]> {
    const out: JiraIssue[] = [];
    if (this.cfg.flavor === "cloud") {
      let token: string | undefined;
      do {
        const page: { issues: JiraIssue[]; nextPageToken?: string } = await this.get(
          `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&maxResults=${Math.min(100, max)}${token ? `&nextPageToken=${encodeURIComponent(token)}` : ""}`,
        );
        out.push(...page.issues);
        progress?.(`fetched ${out.length} issues`);
        token = page.nextPageToken;
      } while (token && out.length < max);
    } else {
      for (let startAt = 0; out.length < max; startAt += 100) {
        const page = await this.get<{ issues: JiraIssue[]; total: number }>(
          `/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${FIELDS}&maxResults=100&startAt=${startAt}`,
        );
        out.push(...page.issues);
        progress?.(`fetched ${out.length} issues`);
        if (page.issues.length < 100 || out.length >= page.total) break;
      }
    }
    return out.slice(0, max);
  }

  async test() {
    if (!this.rt.secret()) return { ok: false, detail: "no API token configured" };
    if (this.cfg.flavor === "cloud" && !this.cfg.email) return { ok: false, detail: "Jira Cloud needs your Atlassian account email" };
    try {
      const me = await this.get<{ displayName?: string; name?: string }>(`/rest/api/${this.v}/myself`);
      return { ok: true, detail: `signed in as ${me.displayName ?? me.name ?? "unknown"}${this.cfg.jql ? ` · sync JQL: ${this.cfg.jql}` : " · live search only (no sync JQL)"}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async sync(progress?: ProgressFn): Promise<ExternalDocInput[]> {
    if (!this.cfg.jql) return [];
    const issues = await this.search(this.cfg.jql, this.cfg.limit, progress);
    return issues.map((i) => ({
      id: i.key,
      title: `${i.key} ${i.fields.summary}`,
      path: i.key,
      url: `${this.base}/browse/${i.key}`,
      updatedAt: i.fields.updated,
      text: this.format(i),
    }));
  }

  tools(): Tool<any>[] {
    const prefix = this.id === "jira" ? "jira" : `jira_${this.id.replace(/-/g, "_")}`;
    const search: Tool<{ jql: string; limit?: number }> = {
      name: `${prefix}_search`,
      description: "Search Jira live with JQL, e.g. 'project = PAY AND text ~ \"refund\" ORDER BY updated DESC'. Returns keys, summaries, status and urls.",
      access: "read",
      schema: z.object({ jql: z.string().min(1), limit: z.number().int().positive().max(50).optional() }),
      describe: (i) => `JQL ${i.jql}`,
      run: async (input) => {
        const issues = await this.search(input.jql, input.limit ?? 15);
        const lines = issues.map((i) => `${i.key} [${i.fields.status?.name ?? "?"}] ${i.fields.summary} — ${this.base}/browse/${i.key}`);
        return { content: lines.join("\n") || "No matching issues.", summary: `JQL → ${issues.length} issues` };
      },
    };
    const get: Tool<{ key: string }> = {
      name: `${prefix}_get_issue`,
      description: "Fetch one Jira issue by key (e.g. PAY-123) with its description and recent comments.",
      access: "read",
      schema: z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/i) }),
      describe: (i) => `Jira ${i.key}`,
      run: async (input) => {
        const issue = await this.get<JiraIssue>(`/rest/api/${this.v}/issue/${encodeURIComponent(input.key)}?fields=${FIELDS}`);
        return { content: truncateMiddle(this.format(issue), 20_000), summary: `Fetched ${issue.key}: ${issue.fields.summary}` };
      },
    };
    return [search, get];
  }
}
