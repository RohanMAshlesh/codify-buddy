import fs from "node:fs";
import path from "node:path";
import type { DocsConnectorSchema } from "../config/config.js";
import type { ExternalDocInput } from "../context/index.js";
import { walkProject } from "../context/walker.js";
import { htmlToText } from "./convert.js";
import type { Connector, ConnectorRuntime } from "./types.js";
import type { z } from "zod";

const DOC_EXTS = new Set([".md", ".mdx", ".markdown", ".txt", ".rst", ".html", ".htm"]);

function titleFrom(text: string, rel: string): string {
  const h = /^#\s+(.+)$/m.exec(text);
  if (h) return h[1]!.trim();
  return path.basename(rel).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}

/**
 * A folder of documents: team notes, a Confluence/Notion HTML or Markdown
 * export, ADRs, runbooks. Works fully offline.
 */
export class DocsConnector implements Connector {
  readonly type = "docs";
  readonly id: string;
  readonly label: string;
  private readonly dir: string;

  constructor(cfg: z.infer<typeof DocsConnectorSchema>, rt: ConnectorRuntime) {
    this.id = cfg.id;
    this.dir = path.resolve(rt.root, cfg.path);
    this.label = cfg.label ?? `Docs folder ${cfg.path}`;
  }

  async test() {
    if (!fs.existsSync(this.dir) || !fs.statSync(this.dir).isDirectory()) return { ok: false, detail: `folder not found: ${this.dir}` };
    const n = this.files().length;
    return { ok: n > 0, detail: n > 0 ? `${n} documents in ${this.dir}` : `no .md/.txt/.html files in ${this.dir}` };
  }

  private files() {
    return walkProject(this.dir, { maxFileBytes: 5_000_000 }).filter((f) => DOC_EXTS.has(path.extname(f.rel).toLowerCase()));
  }

  async sync(): Promise<ExternalDocInput[]> {
    return this.files().map((f) => {
      const raw = fs.readFileSync(f.abs, "utf8");
      const isHtml = /\.html?$/i.test(f.rel);
      const htmlTitle = isHtml ? /<title>([^<]+)<\/title>/i.exec(raw)?.[1]?.trim() : undefined;
      const text = isHtml ? htmlToText(raw) : raw;
      return {
        id: f.rel,
        title: htmlTitle || titleFrom(text, f.rel),
        path: f.rel.replace(/\.[^.]+$/, ""),
        url: `file://${f.abs}`,
        updatedAt: new Date(f.mtimeMs).toISOString(),
        text,
      };
    });
  }

  tools() {
    return [];
  }
}
