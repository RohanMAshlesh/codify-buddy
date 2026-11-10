// Builds the extension, its webview script, and a self-contained copy of the
// Codify Buddy engine (the CLI from ../src) that the extension runs as a child process.
import fs from "node:fs";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
fs.rmSync("dist", { recursive: true, force: true });

const builds = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
    sourcemap: watch,
  },
  {
    entryPoints: ["src/webview/chat.ts"],
    outfile: "dist/webview/chat.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
  },
  {
    // The engine, bundled with all its dependencies so the .vsix needs no node_modules.
    entryPoints: ["../src/cli/index.ts"],
    outfile: "dist/server/codify.mjs",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logOverride: { "empty-import-meta": "silent" },
  },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log("watching…");
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  fs.copyFileSync("src/webview/chat.css", "dist/webview/chat.css");
  console.log("built dist/extension.js, dist/webview/, dist/server/codify.mjs");
}
