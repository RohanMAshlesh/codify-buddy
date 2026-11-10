const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  scala: "scala", rb: "ruby", php: "php", cs: "csharp", swift: "swift",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cxx: "cpp",
  md: "markdown", mdx: "markdown", rst: "text", txt: "text",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml",
  html: "html", css: "css", scss: "css", sql: "sql", sh: "shell", bash: "shell", zsh: "shell",
  proto: "proto", graphql: "graphql", gql: "graphql", tf: "terraform", vue: "vue", svelte: "svelte",
};

const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile", makefile: "makefile", gemfile: "ruby", rakefile: "ruby",
};

export function languageFor(filePath: string): string {
  const base = filePath.split("/").pop()!.toLowerCase();
  if (NAME_LANG[base]) return NAME_LANG[base]!;
  const ext = base.includes(".") ? base.split(".").pop()! : "";
  return EXT_LANG[ext] ?? "text";
}

export const CODE_LANGS = new Set([
  "typescript", "javascript", "python", "go", "rust", "java", "kotlin", "scala", "ruby",
  "php", "csharp", "swift", "c", "cpp",
]);
