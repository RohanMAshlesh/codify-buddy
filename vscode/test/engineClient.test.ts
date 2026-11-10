import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EngineClient, ERR_MISSING_CREDENTIALS, RpcError } from "../src/engineClient.js";

// Tests run from the vscode/ folder (npm test).
const serverPath = path.resolve(process.cwd(), "dist/server/codify.mjs");

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codify-vscode-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src/refund.ts"), "export function refundAmount(c: number) {\n  return Math.floor(c / 2);\n}\n");
  return dir;
}

let client: EngineClient | null = null;
afterEach(async () => {
  await client?.stop();
  client = null;
});

beforeAll(() => {
  if (!fs.existsSync(serverPath)) throw new Error(`Build the extension first (npm run build): ${serverPath} is missing`);
});

describe("EngineClient against the bundled engine", () => {
  it("reports missing credentials with a dedicated code", async () => {
    client = new EngineClient({ serverPath, cwd: project(), env: { CODIFY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ch-")), ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } });
    client.start();
    const err = await client.request("initialize", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(ERR_MISSING_CREDENTIALS);
  }, 20_000);

  it("initializes, searches, changes settings and shuts down", async () => {
    const cwd = project();
    client = new EngineClient({ serverPath, cwd, env: { CODIFY_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ch-")), ANTHROPIC_API_KEY: "sk-ant-test-0000" } });
    const exits: boolean[] = [];
    client.onExit((_code, expected) => exits.push(expected));
    client.start();
    const info = await client.request<{ root: string; files: number; mode: string }>("initialize", { cwd, mode: "auto-edit" });
    expect(info).toMatchObject({ files: 1, mode: "auto-edit" });
    expect(fs.realpathSync(info.root)).toBe(fs.realpathSync(cwd));

    const res = await client.request<{ hits: Array<{ citation: string }> }>("context/search", { query: "refund amount" });
    expect(res.hits[0]!.citation).toBe("src/refund.ts:1-3");
    expect(await client.request("chat/setMode", { mode: "read-only" })).toEqual({ mode: "read-only" });
    const err = await client.request("nope").catch((e) => e);
    expect((err as RpcError).code).toBe(-32601);

    await client.stop();
    expect(client.running).toBe(false);
    expect(exits).toEqual([true]);
    await expect(client.request("sources/list")).rejects.toThrow(/not running/);
  }, 20_000);
});
