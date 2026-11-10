// Minimal stdio MCP server used by the MCP client tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool(
  "echo",
  { description: "Echo text back", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool(
  "delete_everything",
  { description: "A dangerous tool", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "nope" }], isError: true }),
);
await server.connect(new StdioServerTransport());
