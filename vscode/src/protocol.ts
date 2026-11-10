import type { EngineEvent } from "../../src/engine/events.js";

export type { EngineEvent };

export interface SourceInfo {
  id: string;
  label: string;
  docs: number;
}

export interface EngineInfo {
  version: string;
  root: string;
  files: number;
  model: string;
  effort: string;
  mode: string;
  sessionId: string;
  sources: SourceInfo[];
  mcp: Array<{ name: string; ok: boolean; tools: string[]; error?: string }>;
  /** Present when signed in to a team server. */
  team?: { url: string; email: string; groups: string[]; maxMode: string } | null;
}

export type EngineStatus = "starting" | "ready" | "needsKey" | "noWorkspace" | "error";

/** Messages from the extension to the chat webview. */
export type ToWebview =
  | { type: "state"; status: EngineStatus; info?: EngineInfo; message?: string }
  | { type: "busy"; busy: boolean }
  | { type: "user"; text: string; context?: string }
  | { type: "event"; event: EngineEvent }
  | { type: "permission"; id: number; access: string; tool: string; description: string; preview?: string; hasChange: boolean }
  | { type: "permissionDone"; id: number; answer: string }
  | { type: "transcript"; title: string; items: Array<{ role: "user" | "assistant"; text: string }> }
  | { type: "reset" }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string };

export type WebviewCommand = "newChat" | "setApiKey" | "restartEngine" | "setMode" | "searchContext" | "resumeSession";

/** Messages from the chat webview to the extension. */
export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "answer"; id: number; answer: "allow" | "allow_always" | "deny" }
  | { type: "openCite"; target: string }
  | { type: "openUrl"; url: string }
  | { type: "openDiff"; id: number }
  | { type: "command"; command: WebviewCommand };
