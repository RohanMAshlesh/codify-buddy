import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { formatMcpContent, McpHub, mcpToolName } from "../src/mcp/client.js";
import { createContextServer } from "../src/mcp/server.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { makeTempDir } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("MCP context server", () => {
  it("serves search, documents and sources over MCP", async () => {
    process.env.CODIFY_HOME = makeTempDir();
    const root = makeTempDir({ ".git/HEAD": "x", "src/refund.ts": "export function refundAmount(c: number) {\n  return Math.floor(c / 2);\n}\n" });
    const { server, index } = createContextServer(root);
    index.setExternalSource({ id: "wiki", kind: "docs", label: "Wiki", docs: [{ id: "1", title: "Refund Policy", url: "https://wiki/1", text: "# Refund Policy\n\nRound half up.\n" }] });

    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(b);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["find_files", "list_sources", "read_document", "search_context"]);

    const search = (await client.callTool({ name: "search_context", arguments: { query: "refund amount rounding" } })) as { content: Array<{ text: string }> };
    expect(search.content[0]!.text).toContain('citation="src/refund.ts:1-3"');
    expect(search.content[0]!.text).toContain('url="https://wiki/1"');

    const doc = (await client.callTool({ name: "read_document", arguments: { path: "@wiki/refund-policy" } })) as { content: Array<{ text: string }> };
    expect(doc.content[0]!.text).toContain("3\tRound half up.");
    const bad = (await client.callTool({ name: "read_document", arguments: { path: "../../etc/passwd" } })) as { isError: boolean };
    expect(bad.isError).toBe(true);

    const sources = (await client.callTool({ name: "list_sources", arguments: {} })) as { content: Array<{ text: string }> };
    expect(sources.content[0]!.text).toContain("@wiki: Wiki (docs), 1 documents");
    await client.close();
  });
});

describe("MCP client hub", () => {
  let hub: McpHub;
  afterEach(async () => hub?.close());

  it("adapts stdio server tools with permission levels", async () => {
    hub = new McpHub();
    const status = await hub.connectAll({
      echo: { command: process.execPath, args: [path.join(here, "fixtures/echo-mcp.mjs")], env: {}, trusted: false },
      broken: { command: "definitely-not-a-real-binary-xyz", args: [], env: {}, trusted: false },
    }, 10_000);
    expect(status.map((s) => [s.name, s.ok])).toEqual([["broken", false], ["echo", true]]);

    const tools = hub.tools();
    expect(tools.map((t) => [t.name, t.access])).toEqual([
      ["mcp__echo__delete_everything", "exec"],
      ["mcp__echo__echo", "read"],
    ]);
    const echo = tools.find((t) => t.name === "mcp__echo__echo")!;
    expect(await echo.run({ text: "hi" }, {} as never)).toMatchObject({ content: "echo: hi", isError: false });
    const danger = tools.find((t) => t.name === "mcp__echo__delete_everything")!;
    expect((await danger.run({}, {} as never)).isError).toBe(true);

    // Raw JSON schemas pass through to the model's tool definitions.
    const reg = new ToolRegistry([echo]);
    expect(reg.definitions()[0]!.input_schema).toMatchObject({ type: "object", properties: { text: { type: "string" } }, required: ["text"] });
  }, 20_000);

  it("names and formats", () => {
    expect(mcpToolName("my server", "do.thing")).toBe("mcp__my_server__do_thing");
    expect(mcpToolName("s", "x".repeat(100))).toHaveLength(64);
    expect(formatMcpContent([{ type: "text", text: "a" }, { type: "image", mimeType: "image/png" }])).toBe("a\n[image image/png omitted]");
  });
});
