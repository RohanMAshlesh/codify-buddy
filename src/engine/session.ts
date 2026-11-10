import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { ensureDir, projectDir } from "../config/paths.js";
import { emptyUsage, type Usage } from "../model/pricing.js";

export interface SessionData {
  id: string;
  createdAt: string;
  updatedAt: string;
  title: string;
  model: string;
  /** Frozen per-session system context (see buildSessionContext). */
  systemContext: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  usage: Usage;
}

export function sessionsDir(root: string): string {
  return path.join(projectDir(root), "sessions");
}

export function newSession(model: string, systemContext: string): SessionData {
  const now = new Date().toISOString();
  return {
    id: `${now.slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex")}`,
    createdAt: now,
    updatedAt: now,
    title: "",
    model,
    systemContext,
    messages: [],
    usage: emptyUsage(),
  };
}

export function saveSession(root: string, s: SessionData): void {
  const dir = ensureDir(sessionsDir(root));
  s.updatedAt = new Date().toISOString();
  const file = path.join(dir, `${s.id}.json`);
  fs.writeFileSync(file + ".tmp", JSON.stringify(s));
  fs.renameSync(file + ".tmp", file);
}

export function loadSession(root: string, id: string): SessionData | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionsDir(root), `${id}.json`), "utf8")) as SessionData;
  } catch {
    return null;
  }
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
}

export function listSessions(root: string): SessionSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(sessionsDir(root)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => loadSession(root, f.replace(/\.json$/, "")))
    .filter((s): s is SessionData => !!s)
    .map((s) => ({
      id: s.id,
      title: s.title,
      updatedAt: s.updatedAt,
      turns: s.messages.filter((m) => m.role === "user" && typeof m.content === "string").length,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
