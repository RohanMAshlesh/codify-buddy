import type { Usage } from "../model/pricing.js";

export type EngineEvent =
  | { type: "turn_start" }
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; description: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string; diff?: string; display?: string }
  | { type: "usage"; turn: Usage; session: Usage; costUsd: number | null }
  | { type: "notice"; level: "info" | "warn" | "error"; message: string }
  | { type: "turn_end"; stopReason: string; text: string };

export type EventSink = (event: EngineEvent) => void;
