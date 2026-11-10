import { z } from "zod";
import type { ConfluenceConnectorSchema } from "../config/config.js";
import type { ExternalDocInput } from "../context/index.js";
import type { Tool } from "../tools/types.js";
import { truncateMiddle } from "../util/tokens.js";
import { htmlToText } from "./convert.js";
import { basicAuth, getJson, trimBase, type HttpOptions } from "./http.js";
import type { Connector, ConnectorRuntime, ProgressFn } from "./types.js";

type Cfg = z.infer<typeof ConfluenceConnectorSchema>;

interface V2Page {
  id: string;
  title: string;
  body?: { storage?: { value: string } };
  version?: { createdAt?: string };
  _links?: { webui?: string };
}
interface V1Content {
  id: string;
  title: string;
  body?: { storage?: { value: string } };
  version?: { when?: string };
  _links?: { webui?: string };
}
interface V1SearchResult {
  content?: { id: string; title: string; _links?: { webui?: string } };
  title?: string;
  excerpt?: string;
  url?: string;
}

/**
 * Confluence Cloud (REST v2, email + API token) or Data Center (REST v1,
 * personal access token). Results reflect what the token's owner can see.
 */
export class ConfluenceConnector implements Connector {
  readonly type = "confluence";
  readonly id: string;
  readonly label: string;
  private readonly base: string;

  constructor(private readonly cfg: Cfg, private readonly rt: ConnectorRuntime) {
    this.id = cfg.id;
    this.base = trimBase(cfg.baseUrl);
    this.label = cfg.label ?? `Confluence ${cfg.spaces.join(", ")}`;
  }

  private opts(): HttpOptions {
    const token = this.rt.secret();
    const headers: Record<string, string> = {};
    if (token) {
      headers.authorization = this.cfg.flavor === "cloud" ? basicAuth(this.cfg.email ?? "", token) : `Bearer ${token}`;
    }
    return { service: "Confluence", headers };
  }

  private get<T>(url: string): Promise<T> {
    return getJson<T>(this.rt.fetch, url.startsWith("http") ? url : `${this.base}${url}`, this.opts());
  }

  private origin(): string {
    return new URL(this.base).origin;
  }

  private pageUrl(webui?: string): string | undefined {
    return webui ? `${this.base}${webui}` : undefined;
  }

  async test() {
    if (!this.rt.secret()) return { ok: false, detail: "no API token configured" };
    if (this.cfg.flavor === "cloud" && !this.cfg.email) return { ok: false, detail: "Confluence Cloud needs your Atlassian account email" };
    try {
      const found: string[] = [];
      for (const key of this.cfg.spaces) {
        if (this.cfg.flavor === "cloud") {
          const r = await this.get<{ results: Array<{ key: string; name: string }> }>(`/api/v2/spaces?keys=${encodeURIComponent(key)}`);
          if (!r.results.length) return { ok: false, detail: `space ${key} not found or not visible to this account` };
          found.push(`${key} (${r.results[0]!.name})`);
        } else {
          const r = await this.get<{ key: string; name: string }>(`/rest/api/space/${encodeURIComponent(key)}`);
          found.push(`${r.key} (${r.name})`);
        }
      }
      return { ok: true, detail: `spaces: ${found.join(", ")}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }

  async sync(progress?: ProgressFn): Promise<ExternalDocInput[]> {
    const docs: ExternalDocInput[] = [];
    for (const key of this.cfg.spaces) {
      const before = docs.length;
      if (this.cfg.flavor === "cloud") await this.syncCloudSpace(key, docs, progress);
      else await this.syncDcSpace(key, docs, progress);
      progress?.(`space ${key}: ${docs.length - before} pages`);
      if (docs.length >= this.cfg.limit) break;
    }
    return docs.slice(0, this.cfg.limit);
  }

  private async syncCloudSpace(key: string, out: ExternalDocInput[], progress?: ProgressFn) {
    const spaces = await this.get<{ results: Array<{ id: string }> }>(`/api/v2/spaces?keys=${encodeURIComponent(key)}`);
    const spaceId = spaces.results[0]?.id;
    if (!spaceId) throw new Error(`Confluence space ${key} not found`);
    let next: string | undefined = `/api/v2/spaces/${spaceId}/pages?body-format=storage&limit=100&status=current`;
    while (next && out.length < this.cfg.limit) {
      const page: { results: V2Page[]; _links?: { next?: string } } = await this.get(next);
      for (const p of page.results) {
        out.push({
          id: p.id,
          title: p.title,
          path: `${key}/${p.title}`,
          url: this.pageUrl(p._links?.webui),
          updatedAt: p.version?.createdAt,
          text: `# ${p.title}\n\n${htmlToText(p.body?.storage?.value ?? "")}`,
        });
      }
      progress?.(`space ${key}: ${out.length} pages so far`);
      // `next` is an absolute path on the site origin, e.g. /wiki/api/v2/...
      next = page._links?.next ? `${this.origin()}${page._links.next}` : undefined;
    }
  }

  private async syncDcSpace(key: string, out: ExternalDocInput[], progress?: ProgressFn) {
    for (let start = 0; out.length < this.cfg.limit; start += 50) {
      const page = await this.get<{ results: V1Content[]; size: number }>(
        `/rest/api/content?spaceKey=${encodeURIComponent(key)}&type=page&expand=body.storage,version&limit=50&start=${start}`,
      );
      for (const p of page.results) {
        out.push({
          id: p.id,
          title: p.title,
          path: `${key}/${p.title}`,
          url: this.pageUrl(p._links?.webui),
          updatedAt: p.version?.when,
          text: `# ${p.title}\n\n${htmlToText(p.body?.storage?.value ?? "")}`,
        });
      }
      progress?.(`space ${key}: ${out.length} pages so far`);
      if (page.size < 50) break;
    }
  }

  async getPage(id: string): Promise<{ title: string; url?: string; text: string }> {
    if (this.cfg.flavor === "cloud") {
      const p = await this.get<V2Page>(`/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`);
      return { title: p.title, url: this.pageUrl(p._links?.webui), text: htmlToText(p.body?.storage?.value ?? "") };
    }
    const p = await this.get<V1Content>(`/rest/api/content/${encodeURIComponent(id)}?expand=body.storage`);
    return { title: p.title, url: this.pageUrl(p._links?.webui), text: htmlToText(p.body?.storage?.value ?? "") };
  }

  tools(): Tool<any>[] {
    const prefix = this.id === "confluence" ? "confluence" : `confluence_${this.id.replace(/-/g, "_")}`;
    const spaceClause = this.cfg.spaces.length ? ` AND space in (${this.cfg.spaces.map((s) => `"${s}"`).join(",")})` : "";
    const search: Tool<{ query: string; all_spaces?: boolean }> = {
      name: `${prefix}_search`,
      description: `Search Confluence live (${this.cfg.spaces.join(", ")}). Use for pages that may not be in the local index or that changed recently. Returns titles, excerpts, page ids and urls.`,
      access: "read",
      schema: z.object({ query: z.string().min(1), all_spaces: z.boolean().optional().describe("search every space you can access") }),
      describe: (i) => `Confluence search "${i.query}"`,
      run: async (input) => {
        const cql = `type=page AND text ~ "${input.query.replace(/"/g, '\\"')}"${input.all_spaces ? "" : spaceClause}`;
        const res = await this.get<{ results: V1SearchResult[] }>(
          `${this.cfg.flavor === "cloud" ? "/rest/api/search" : "/rest/api/content/search"}?cql=${encodeURIComponent(cql)}&limit=10`,
        );
        const lines = res.results.map((r) => {
          const id = r.content?.id ?? "";
          const title = r.content?.title ?? r.title ?? "(untitled)";
          const url = this.pageUrl(r.content?._links?.webui ?? r.url);
          const excerpt = (r.excerpt ?? "").replace(/@@@(end)?hl@@@/g, "").replace(/\s+/g, " ").trim();
          return `- ${title} (id ${id})${url ? ` ${url}` : ""}${excerpt ? `\n  ${excerpt.slice(0, 240)}` : ""}`;
        });
        return { content: lines.join("\n") || "No matching pages.", summary: `Confluence "${input.query}" → ${res.results.length} pages` };
      },
    };
    const get: Tool<{ page_id: string }> = {
      name: `${prefix}_get_page`,
      description: "Fetch the full, current content of a Confluence page by id.",
      access: "read",
      schema: z.object({ page_id: z.string().min(1) }),
      describe: (i) => `Confluence page ${i.page_id}`,
      run: async (input) => {
        const p = await this.getPage(input.page_id);
        return { content: truncateMiddle(`# ${p.title}\n${p.url ?? ""}\n\n${p.text}`, 20_000), summary: `Fetched "${p.title}"` };
      },
    };
    return [search, get];
  }
}
