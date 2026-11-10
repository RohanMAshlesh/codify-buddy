import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli/index.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  sourcemap: true,
  clean: true,
  dts: false,
  banner: ({ format }) => (format === "esm" ? { js: "" } : {}),
});
