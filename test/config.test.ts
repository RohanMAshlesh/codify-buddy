import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, parseConfigValue, projectConfigFile, setConfigValue } from "../src/config/config.js";
import { maskKey, resolveCredentials, saveApiKey } from "../src/config/credentials.js";
import { findProjectRoot } from "../src/config/paths.js";
import { makeTempDir } from "./helpers.js";

let home: string;
const prevHome = process.env.CODIFY_HOME;

beforeEach(() => {
  home = makeTempDir();
  process.env.CODIFY_HOME = home;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.CODIFY_HOME;
  else process.env.CODIFY_HOME = prevHome;
});

describe("loadConfig", () => {
  it("returns defaults with no files", () => {
    const cfg = loadConfig(makeTempDir(), {}, {});
    expect(cfg.model).toBe("claude-opus-5-5");
    expect(cfg.effort).toBe("medium");
    expect(cfg.permissionMode).toBe("ask");
    expect(cfg.context.budgetTokens).toBe(12_000);
  });

  it("applies global < project < env < overrides", () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ effort: "low", maxTurns: 5 }));
    fs.mkdirSync(path.join(root, ".codify"));
    fs.writeFileSync(projectConfigFile(root), JSON.stringify({ effort: "high", context: { budgetTokens: 999 } }));
    const cfg = loadConfig(root, { permissionMode: "yolo" }, { CODIFY_MODEL: "claude-sonnet-5-5" });
    expect(cfg.maxTurns).toBe(5);
    expect(cfg.effort).toBe("high");
    expect(cfg.context.budgetTokens).toBe(999);
    expect(cfg.context.repoMapTokens).toBe(3_000);
    expect(cfg.model).toBe("claude-sonnet-5-5");
    expect(cfg.permissionMode).toBe("yolo");
  });

  it("rejects invalid values with a readable message", () => {
    expect(() => loadConfig(makeTempDir(), { effort: "extreme" as never }, {})).toThrow(/effort/);
  });

  it("setConfigValue writes dotted keys and validates", () => {
    const file = path.join(home, "config.json");
    setConfigValue(file, "context.budgetTokens", parseConfigValue("5000"));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ context: { budgetTokens: 5000 } });
    expect(() => setConfigValue(file, "effort", "nope")).toThrow();
  });
});

describe("credentials", () => {
  it("prefers env over stored key", () => {
    saveApiKey("sk-ant-stored-123456789");
    expect(resolveCredentials({}).source).toBe("file");
    expect(resolveCredentials({ ANTHROPIC_API_KEY: "sk-env" }).apiKey).toBe("sk-env");
    if (process.platform !== "win32") {
      const mode = fs.statSync(path.join(home, "credentials.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("masks keys", () => {
    expect(maskKey("sk-ant-api03-abcdefghijklmnop")).toBe("sk-ant-…mnop");
  });
});

describe("findProjectRoot", () => {
  it("walks up to the nearest .git", () => {
    const root = makeTempDir({ ".git/HEAD": "ref", "a/b/c.txt": "x" });
    expect(findProjectRoot(path.join(root, "a/b"))).toBe(root);
  });
});
