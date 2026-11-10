import type { EngineInfo, FromWebview, ToWebview } from "../protocol.js";
import { escapeHtml, renderDiff, renderMarkdown } from "./render.js";

declare function acquireVsCodeApi(): { postMessage(msg: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (m: FromWebview) => vscode.postMessage(m);

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const log = $<HTMLDivElement>("log");
const input = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const stopBtn = $<HTMLButtonElement>("stop");
const status = $<HTMLDivElement>("status");
const empty = $<HTMLDivElement>("empty");

let busy = false;
let assistant: { el: HTMLElement; text: string; queued: boolean } | null = null;
let thinkingEl: HTMLElement | null = null;
const toolRows = new Map<string, HTMLElement>();

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function el(tag: string, cls: string, html = ""): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  return e;
}

function append(node: HTMLElement): HTMLElement {
  empty.hidden = true;
  log.appendChild(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

function endAssistant() {
  if (assistant) assistant.el.innerHTML = renderMarkdown(assistant.text);
  assistant = null;
  thinkingEl?.remove();
  thinkingEl = null;
}

function addText(delta: string) {
  thinkingEl?.remove();
  thinkingEl = null;
  if (!assistant) assistant = { el: append(el("div", "msg assistant")), text: "", queued: false };
  assistant.text += delta;
  if (!assistant.queued) {
    const a = assistant;
    a.queued = true;
    requestAnimationFrame(() => {
      a.el.innerHTML = renderMarkdown(a.text);
      a.queued = false;
      log.scrollTop = log.scrollHeight;
    });
  }
}

function setBusy(b: boolean) {
  busy = b;
  sendBtn.hidden = b;
  stopBtn.hidden = !b;
  input.placeholder = b ? "Working…" : "Ask about your code and docs…";
  input.title = "Enter to send · Shift+Enter for a new line";
}

function renderStatus(info?: EngineInfo) {
  if (!info) return;
  const sources = info.sources.length ? ` · ${info.sources.map((s) => `@${s.id} (${s.docs})`).join(" ")}` : "";
  const team = info.team ? ` · team ${info.team.email}` : "";
  const mcp = info.mcp.filter((m) => m.ok).length ? ` · MCP ${info.mcp.filter((m) => m.ok).map((m) => m.name).join(", ")}` : "";
  status.innerHTML = `<span>${escapeHtml(info.files.toString())} files${escapeHtml(sources)}${escapeHtml(mcp)}${escapeHtml(team)}</span><span class="mode" title="Permission mode — click to change">${escapeHtml(info.mode)}</span>`;
  status.querySelector(".mode")!.addEventListener("click", () => post({ type: "command", command: "setMode" }));
}

function notice(level: string, message: string, actions: Array<[string, () => void]> = []) {
  const n = append(el("div", `notice ${level}`, escapeHtml(message)));
  if (actions.length) {
    const row = el("div", "actions");
    for (const [label, fn] of actions) {
      const b = el("button", "secondary", escapeHtml(label)) as HTMLButtonElement;
      b.addEventListener("click", fn);
      row.appendChild(b);
    }
    n.appendChild(row);
  }
  return n;
}

window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  const m = e.data;
  switch (m.type) {
    case "state":
      if (m.status === "ready") renderStatus(m.info);
      else if (m.status === "starting") status.textContent = "Starting the engine…";
      else if (m.status === "needsKey") {
        status.textContent = "Needs an API key";
        notice("warn", "Codify Buddy uses your own Anthropic API key. It's stored in VS Code's secret storage.", [
          ["Add API key", () => post({ type: "command", command: "setApiKey" })],
        ]);
      } else if (m.status === "noWorkspace") status.textContent = "Open a folder to start";
      else if (m.status === "error") {
        status.textContent = "Engine stopped";
        notice("error", m.message ?? "The engine stopped.", [["Restart engine", () => post({ type: "command", command: "restartEngine" })]]);
      }
      break;
    case "busy":
      setBusy(m.busy);
      if (!m.busy) endAssistant();
      break;
    case "user": {
      endAssistant();
      const u = append(el("div", "msg user", escapeHtml(m.text)));
      if (m.context) u.prepend(el("div", "chip", escapeHtml(m.context)));
      break;
    }
    case "event": {
      const ev = m.event;
      if (ev.type === "text") addText(ev.text);
      else if (ev.type === "thinking") {
        if (!thinkingEl && !assistant) thinkingEl = append(el("div", "thinking", "Thinking…"));
      } else if (ev.type === "tool_call") {
        endAssistant();
        const row = append(el("div", "tool", `<span class="dot">●</span> <b>${escapeHtml(ev.name)}</b> <span class="desc">${escapeHtml(ev.description)}</span>`));
        toolRows.set(ev.id, row);
      } else if (ev.type === "tool_result") {
        const row = toolRows.get(ev.id) ?? append(el("div", "tool", `<b>${escapeHtml(ev.name)}</b>`));
        row.classList.add(ev.ok ? "ok" : "fail");
        const res = el("div", "result", `⎿ ${escapeHtml(ev.summary)}`);
        row.appendChild(res);
        if (ev.display) row.appendChild(el("pre", "display", escapeHtml(ev.display)));
        if (ev.diff) {
          const d = el("details", "diffbox", `<summary>diff</summary>${renderDiff(ev.diff)}`);
          row.appendChild(d);
        }
      } else if (ev.type === "usage") {
        const u = ev.session;
        const cost = ev.costUsd === null ? "" : ` · ~$${ev.costUsd.toFixed(ev.costUsd < 0.1 ? 4 : 2)}`;
        status.dataset.usage = `in ${tokens(u.inputTokens)} · cached ${tokens(u.cacheReadTokens)} · out ${tokens(u.outputTokens)}${cost}`;
        status.title = status.dataset.usage;
      } else if (ev.type === "notice") {
        endAssistant();
        notice(ev.level, ev.message);
      } else if (ev.type === "turn_end") {
        endAssistant();
        if (status.dataset.usage) append(el("div", "usage", escapeHtml(status.dataset.usage)));
      }
      break;
    }
    case "permission": {
      endAssistant();
      const label = m.access === "exec" ? "Run command" : "Change files";
      const card = append(el("div", "permission", `<div class="ptitle">${escapeHtml(label)}: <code>${escapeHtml(m.description)}</code></div>`));
      card.dataset.id = String(m.id);
      if (m.preview) card.appendChild(el("div", "", renderDiff(m.preview, 40)));
      const row = el("div", "actions");
      const btn = (text: string, cls: string, fn: () => void) => {
        const b = el("button", cls, escapeHtml(text)) as HTMLButtonElement;
        b.addEventListener("click", fn);
        row.appendChild(b);
      };
      btn("Allow", "", () => post({ type: "answer", id: m.id, answer: "allow" }));
      btn("Always allow", "secondary", () => post({ type: "answer", id: m.id, answer: "allow_always" }));
      btn("Deny", "secondary danger", () => post({ type: "answer", id: m.id, answer: "deny" }));
      if (m.hasChange) btn("Review diff", "link", () => post({ type: "openDiff", id: m.id }));
      card.appendChild(row);
      break;
    }
    case "permissionDone": {
      const card = log.querySelector<HTMLElement>(`.permission[data-id="${m.id}"]`);
      if (card) {
        card.classList.add("done");
        card.querySelector(".actions")!.innerHTML = `<span class="answer">${m.answer === "deny" ? "Denied" : m.answer === "allow_always" ? "Allowed (always)" : "Allowed"}</span>`;
      }
      break;
    }
    case "transcript":
      log.innerHTML = "";
      notice("info", `Resumed: ${m.title || "session"}`);
      for (const item of m.items) append(el("div", `msg ${item.role}`, item.role === "user" ? escapeHtml(item.text) : renderMarkdown(item.text)));
      break;
    case "reset":
      log.innerHTML = "";
      assistant = null;
      toolRows.clear();
      empty.hidden = false;
      break;
    case "notice":
      notice(m.level, m.message);
      break;
  }
});

function send() {
  const text = input.value.trim();
  if (!text || busy) return;
  post({ type: "send", text });
  input.value = "";
  input.style.height = "";
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  input.style.height = "";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
});
sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => post({ type: "stop" }));

// Citation and link clicks are handled by the extension (open file at line, open URL).
log.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  if (a.dataset.cite) post({ type: "openCite", target: a.dataset.cite });
  else if (a.dataset.href) post({ type: "openUrl", url: a.dataset.href });
});
for (const b of document.querySelectorAll<HTMLElement>("[data-prompt]")) {
  b.addEventListener("click", () => {
    input.value = b.dataset.prompt!;
    input.focus();
  });
}

setBusy(false);
post({ type: "ready" });
