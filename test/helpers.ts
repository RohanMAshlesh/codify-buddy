import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a temp directory populated with `files` (relative path → contents). */
export function makeTempDir(files: Record<string, string> = {}): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codify-test-")));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, contents);
  }
  return dir;
}
