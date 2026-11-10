import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import type { McpServerConfig } from "../config/config.js";
import type { Tool, ToolOutput } from "../tools/types.js";
import { truncateMiddle } from "../util/tokens.js";

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

interface McpContent {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string };
}

export interface McpServerStatus {
  name: string;
  ok: boolean;
  tools: string[];
  error?: string;
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** `mcp__<server>__<tool>`, kept within the API's 64-character limit. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitize(server)}__${sanitize(tool)}`.slice(0, 64);
}

export function formatMcpContent(content: McpContent[]): string {
  return content
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
      if (c.type === "image" || c.type === "audio") return `[${c.type} ${c.mimeType ?? ""} omitted]`;
      if (c.type === "resource_link") return `[resource link]`;
      return `[${c.type} content]`;
    })
    .join("\n");
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Connects to configured MCP servers and adapts their tools for the agent. */
export class McpHub {
  private clients = new Map<string, Client>();
  private toolsByServer = new Map<string, Tool<any>[]>();
  readonly status: McpServerStatus[] = [];

  async connectAll(servers: Record<string, McpServerConfig>, timeoutMs = 15_000): Promise<McpServerStatus[]> {
    const names = Object.keys(servers).sort();
    await Promise.all(names.map((n) => this.connect(n, servers[n]!, timeoutMs)));
    this.status.sort((a, b) => a.name.localeCompare(b.name));
    return this.status;
  }

  private async connect(name: string, cfg: McpServerConfig, timeoutMs: number): Promise<void> {
    const client = new Client({ name: "codify-buddy", version: pkg.version });
    let transport: Transport;
    if ("command" in cfg) {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...(process.env as Record<string, string>), ...cfg.env },
        stderr: "ignore",
      });
    } else {
      transport = new StreamableHTTPClientTransport(new URL(cfg.url), { requestInit: { headers: cfg.headers } });
    }
    try {
      await withTimeout(client.connect(transport), timeoutMs, `MCP server "${name}"`);
      const listed = await withTimeout(client.listTools(), timeoutMs, `listing tools on "${name}"`);
      const tools = (listed.tools as McpToolInfo[]).map((t) => this.adapt(name, cfg, client, t));
      this.clients.set(name, client);
      this.toolsByServer.set(name, tools);
      this.status.push({ name, ok: true, tools: tools.map((t) => t.name) });
    } catch (err) {
      await client.close().catch(() => undefined);
      this.status.push({ name, ok: false, tools: [], error: (err as Error).message });
    }
  }

  private adapt(server: string, cfg: McpServerConfig, client: Client, t: McpToolInfo): Tool<Record<string, unknown>> {
    const readOnly = cfg.trusted || t.annotations?.readOnlyHint === true;
    return {
      name: mcpToolName(server, t.name),
      description: `[MCP: ${server}] ${t.description ?? t.annotations?.title ?? t.name}`.slice(0, 1024),
      // Tools from untrusted servers go through the permission gate like shell commands.
      access: readOnly ? "read" : "exec",
      schema: z.record(z.string(), z.unknown()),
      jsonSchema: t.inputSchema ?? { type: "object" },
      describe: (input) => `${server}.${t.name}(${truncateMiddle(JSON.stringify(input), 40)})`,
      run: async (input): Promise<ToolOutput> => {
        const res = (await client.callTool({ name: t.name, arguments: input })) as { content?: McpContent[]; isError?: boolean; structuredContent?: unknown };
        let text = formatMcpContent(res.content ?? []);
        if (!text && res.structuredContent !== undefined) text = JSON.stringify(res.structuredContent, null, 2);
        return { content: truncateMiddle(text || "(no content)", 20_000), isError: !!res.isError, summary: `${server}.${t.name}${res.isError ? " failed" : ""}` };
      },
    };
  }

  /** All adapted tools, ordered by server then tool name (stable for caching). */
  tools(): Tool<any>[] {
    return [...this.toolsByServer.keys()].sort().flatMap((s) => [...this.toolsByServer.get(s)!].sort((a, b) => a.name.localeCompare(b.name)));
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
  }
}
