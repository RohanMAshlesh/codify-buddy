import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { searchCodeTool } from "./context-tools.js";
import { editFileTool, findFilesTool, grepTool, listDirTool, readFileTool, writeFileTool } from "./fs-tools.js";
import { gitTool, runCommandTool } from "./shell-tools.js";
import type { Tool } from "./types.js";

export const BUILTIN_TOOLS: Tool<any>[] = [
  searchCodeTool,
  findFilesTool,
  readFileTool,
  listDirTool,
  grepTool,
  gitTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
];

export class ToolRegistry {
  private tools = new Map<string, Tool<any>>();

  constructor(tools: Tool<any>[] = BUILTIN_TOOLS) {
    for (const t of tools) this.register(t);
  }

  register(tool: Tool<any>): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool<any> | undefined {
    return this.tools.get(name);
  }

  list(): Tool<any>[] {
    return [...this.tools.values()];
  }

  /**
   * Tool definitions for the Messages API, in a stable order so the prompt
   * cache prefix never changes between requests.
   */
  definitions(): Anthropic.Beta.BetaTool[] {
    return this.list().map((t) => {
      const schema = z.toJSONSchema(t.schema, { target: "draft-2020-12" }) as Record<string, unknown>;
      delete schema.$schema;
      return {
        name: t.name,
        description: t.description,
        input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
        eager_input_streaming: true,
      };
    });
  }
}
