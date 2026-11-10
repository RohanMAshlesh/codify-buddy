import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { globalConfigFile, loadConfig, projectConfigFile } from "../../config/config.js";
import { maskKey, resolveCredentials } from "../../config/credentials.js";
import { findProjectRoot, projectDir } from "../../config/paths.js";
import { ContextIndex, indexOptionsFor } from "../../context/index.js";
import { ConnectorManager } from "../../connectors/manager.js";
import { createClient, describeApiError } from "../../model/client.js";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}

const ICON: Record<Status, string> = { ok: pc.green("✔"), warn: pc.yellow("!"), fail: pc.red("✖") };

/** Diagnose the local setup. Returns the process exit code. */
export async function runDoctor(opts: { cwd?: string; offline?: boolean; json?: boolean } = {}): Promise<number> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const major = Number(process.versions.node?.split(".")[0] ?? 0);
  const runtime = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" ? "bun (standalone)" : `node ${process.versions.node}`;
  add(major >= 20 || runtime.startsWith("bun")
    ? { name: "Runtime", status: "ok", detail: runtime }
    : { name: "Runtime", status: "fail", detail: runtime, fix: "Install Node.js 20 or newer, or use the standalone binary." });

  const root = findProjectRoot(opts.cwd);
  const isGit = fs.existsSync(path.join(root, ".git"));
  add({ name: "Project", status: isGit ? "ok" : "warn", detail: root + (isGit ? " (git)" : " (not a git repo)"), fix: isGit ? undefined : "Run inside a git repository for best results." });

  let config;
  try {
    config = loadConfig(root);
    const sources = [globalConfigFile(), projectConfigFile(root)].filter((f) => fs.existsSync(f));
    add({ name: "Config", status: "ok", detail: `${config.model} · effort ${config.effort} · mode ${config.permissionMode}${sources.length ? ` · from ${sources.join(", ")}` : " · defaults"}` });
  } catch (err) {
    add({ name: "Config", status: "fail", detail: (err as Error).message, fix: "Fix or delete the config file shown above." });
  }

  const creds = resolveCredentials();
  if (creds.source === "none") {
    add({ name: "Credentials", status: "fail", detail: "no API key found", fix: "Run `codify login` or export ANTHROPIC_API_KEY." });
  } else {
    const shown = creds.apiKey ? maskKey(creds.apiKey) : "token";
    add({ name: "Credentials", status: "ok", detail: `${shown} (${creds.source})` });
    if (!opts.offline && config) {
      try {
        const client = createClient(creds);
        const m = await client.models.retrieve(config.model);
        add({ name: "API", status: "ok", detail: `reachable · ${m.display_name ?? m.id}` });
      } catch (err) {
        add({ name: "API", status: "fail", detail: describeApiError(err) });
      }
    }
  }

  try {
    fs.mkdirSync(projectDir(root), { recursive: true });
    fs.accessSync(projectDir(root), fs.constants.W_OK);
    if (config) {
      const idx = new ContextIndex(root, indexOptionsFor(root, config));
      const loaded = idx.load();
      const st = idx.update();
      add({
        name: "Index",
        status: "ok",
        detail: `${idx.fileCount} files · ${idx.chunkCount} chunks · ${loaded ? `refreshed in ${st.ms}ms` : `built in ${st.ms}ms`}`,
      });
      const manager = new ConnectorManager(config.connectors, { root });
      const synced = new Map(idx.sources().map((s) => [s.id, s]));
      for (const c of manager.connectors) {
        const s = synced.get(c.id);
        const syncInfo = s ? `${s.docs} docs synced ${s.syncedAt.slice(0, 10)}` : "not synced";
        if (opts.offline) {
          add({ name: `· ${c.id}`, status: s ? "ok" : "warn", detail: `${c.label} · ${syncInfo}`, fix: s ? undefined : `Run \`codify sync ${c.id}\`.` });
          continue;
        }
        const t = await c.test();
        add({ name: `· ${c.id}`, status: t.ok ? (s ? "ok" : "warn") : "fail", detail: `${t.detail} · ${syncInfo}`, fix: t.ok ? `Run \`codify sync ${c.id}\`.` : `Re-run \`codify connect ${c.type}\`.` });
      }
    }
  } catch (err) {
    add({ name: "Index", status: "fail", detail: (err as Error).message, fix: `Make ${projectDir(root)} writable.` });
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(checks, null, 2) + "\n");
  } else {
    process.stdout.write(pc.bold("Codify Buddy doctor\n\n"));
    for (const c of checks) {
      process.stdout.write(`${ICON[c.status]} ${c.name.padEnd(12)} ${c.detail}\n`);
      if (c.fix && c.status !== "ok") process.stdout.write(pc.dim(`  ${"".padEnd(12)} → ${c.fix}\n`));
    }
  }
  return checks.some((c) => c.status === "fail") ? 1 : 0;
}
