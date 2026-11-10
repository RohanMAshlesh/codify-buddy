import { z } from "zod";
import type { GithubConnectorSchema } from "../config/config.js";
import type { ExternalDocInput } from "../context/index.js";
import { truncateMiddle } from "../util/tokens.js";
import type { Tool } from "../tools/types.js";
import { getJson, trimBase, type HttpOptions } from "./http.js";
import type { Connector, ConnectorRuntime, ProgressFn } from "./types.js";

type Cfg = z.infer<typeof GithubConnectorSchema>;

interface GhUser {
  login: string;
}
interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  updated_at: string;
  created_at: string;
  comments: number;
  user: GhUser | null;
  labels: Array<{ name: string } | string>;
  pull_request?: { merged_at?: string | null };
}
interface GhComment {
  body: string | null;
  user: GhUser | null;
  created_at: string;
}
interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export function formatIssue(i: GhIssue, comments: GhComment[] = []): string {
  const kind = i.pull_request ? "Pull request" : "Issue";
  const state = i.pull_request?.merged_at ? "merged" : i.state;
  const labels = i.labels.map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean);
  const meta = [`${kind} #${i.number}`, state, i.user ? `by @${i.user.login}` : "", labels.length ? `labels: ${labels.join(", ")}` : "", `updated ${i.updated_at.slice(0, 10)}`]
    .filter(Boolean)
    .join(" · ");
  const parts = [`# #${i.number} ${i.title}`, meta, i.html_url, "", (i.body ?? "").trim() || "_No description._"];
  if (comments.length) {
    parts.push("", "## Comments");
    for (const c of comments) parts.push("", `**@${c.user?.login ?? "unknown"}** (${c.created_at.slice(0, 10)}):`, (c.body ?? "").trim());
  }
  return parts.join("\n");
}

/** GitHub issues and pull requests for one repository (REST API v3). */
export class GithubConnector implements Connector {
  readonly type = "github";
  readonly id: string;
  readonly label: string;
  private readonly api: string;

  constructor(private readonly cfg: Cfg, private readonly rt: ConnectorRuntime) {
    this.id = cfg.id;
    this.label = cfg.label ?? `GitHub ${cfg.repo}`;
    this.api = trimBase(cfg.apiUrl);
  }

  private opts(): HttpOptions {
    const token = this.rt.secret();
    return {
      service: "GitHub",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    };
  }

  private get<T>(pathAndQuery: string): Promise<T> {
    return getJson<T>(this.rt.fetch, `${this.api}${pathAndQuery}`, this.opts());
  }

  async test() {
    try {
      const repo = await this.get<{ full_name: string; private: boolean; open_issues_count: number }>(`/repos/${this.cfg.repo}`);
      const auth = this.rt.secret() ? "authenticated" : "unauthenticated (60 requests/hour; set GITHUB_TOKEN for more)";
      return { ok: true, detail: `${repo.full_name}${repo.private ? " (private)" : ""} · ${auth}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async sync(progress?: ProgressFn): Promise<ExternalDocInput[]> {
    const items: GhIssue[] = [];
    for (let page = 1; items.length < this.cfg.limit; page++) {
      const batch = await this.get<GhIssue[]>(
        `/repos/${this.cfg.repo}/issues?state=${this.cfg.state}&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      for (const i of batch) {
        const isPr = !!i.pull_request;
        if ((isPr && this.cfg.pulls) || (!isPr && this.cfg.issues)) items.push(i);
      }
      progress?.(`fetched ${items.length} issues/PRs`);
      if (batch.length < 100) break;
    }
    const chosen = items.slice(0, this.cfg.limit);
    const docs: ExternalDocInput[] = [];
    for (const [n, i] of chosen.entries()) {
      let comments: GhComment[] = [];
      if (i.comments > 0 && n < this.cfg.commentsFor) {
        comments = await this.get<GhComment[]>(`/repos/${this.cfg.repo}/issues/${i.number}/comments?per_page=50`);
      }
      docs.push({
        id: String(i.number),
        title: `#${i.number} ${i.title}`,
        path: `${i.pull_request ? "pulls" : "issues"}/${i.number}`,
        url: i.html_url,
        updatedAt: i.updated_at,
        text: formatIssue(i, comments),
      });
    }
    return docs;
  }

  tools(): Tool<any>[] {
    const repo = this.cfg.repo;
    const prefix = this.id === "github" ? "github" : `github_${this.id.replace(/-/g, "_")}`;
    const getIssue: Tool<{ number: number; include_diff?: boolean }> = {
      name: `${prefix}_get_issue`,
      description: `Fetch a GitHub issue or pull request from ${repo} live, with its comments. For pull requests, set include_diff to also get changed files and patches.`,
      access: "read",
      schema: z.object({ number: z.number().int().positive(), include_diff: z.boolean().optional() }),
      describe: (i) => `${repo}#${i.number}`,
      run: async (input) => {
        const issue = await this.get<GhIssue>(`/repos/${repo}/issues/${input.number}`);
        const comments = issue.comments ? await this.get<GhComment[]>(`/repos/${repo}/issues/${input.number}/comments?per_page=100`) : [];
        let text = formatIssue(issue, comments);
        if (issue.pull_request && input.include_diff) {
          const files = await this.get<GhFile[]>(`/repos/${repo}/pulls/${input.number}/files?per_page=100`);
          text += "\n\n## Changed files\n" + files.map((f) => `\n### ${f.filename} (${f.status}, +${f.additions} -${f.deletions})\n\`\`\`diff\n${f.patch ?? "(binary or too large)"}\n\`\`\``).join("\n");
        }
        return { content: truncateMiddle(text, 20_000), summary: `Fetched ${repo}#${input.number}: ${issue.title}` };
      },
    };
    const search: Tool<{ query: string; type?: "issue" | "pr" }> = {
      name: `${prefix}_search`,
      description: `Search issues and pull requests in ${repo} live (GitHub search syntax, e.g. 'refund label:bug is:open').`,
      access: "read",
      schema: z.object({ query: z.string().min(1), type: z.enum(["issue", "pr"]).optional() }),
      describe: (i) => `search ${repo}: ${i.query}`,
      run: async (input) => {
        const q = `repo:${repo} ${input.type ? `is:${input.type} ` : ""}${input.query}`;
        const res = await this.get<{ total_count: number; items: GhIssue[] }>(`/search/issues?q=${encodeURIComponent(q)}&per_page=15`);
        const lines = res.items.map((i) => `#${i.number} [${i.pull_request ? "PR" : "issue"}, ${i.state}] ${i.title} — ${i.html_url}`);
        return { content: lines.join("\n") || "No matches.", summary: `${repo} search "${input.query}" → ${res.total_count}` };
      },
    };
    return [getIssue, search];
  }
}

/** Parse `owner/name` from a git remote URL (https or ssh). */
export function repoFromRemote(remote: string): string | null {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
