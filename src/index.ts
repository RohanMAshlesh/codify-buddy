/** Public library API: embed the Codify Buddy engine in other tools. */
export { Engine, type EngineOptions } from "./engine/engine.js";
export type { EngineEvent, EventSink } from "./engine/events.js";
export type { TurnResult } from "./engine/agent.js";
export { ContextIndex, type SearchHit, type SearchResult } from "./context/index.js";
export { buildRepoMap } from "./context/repomap.js";
export { loadConfig, type Config, type PermissionMode, type Effort } from "./config/config.js";
export { ToolRegistry } from "./tools/registry.js";
export type { Tool, ToolContext, ToolOutput } from "./tools/types.js";
export { PermissionGate, type PermissionRequest, type PermissionAnswer } from "./tools/permissions.js";
export type { ModelTransport } from "./model/transport.js";
export { RpcServer } from "./rpc/server.js";
