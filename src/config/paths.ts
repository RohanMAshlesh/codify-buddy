import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Directory for user-level config and credentials (`~/.codify`). */
export function globalDir(): string {
  return process.env.CODIFY_HOME ?? path.join(os.homedir(), ".codify");
}

/** Directory for per-project state (index, sessions): `<root>/.codify`. */
export function projectDir(root: string): string {
  return path.join(root, ".codify");
}

/**
 * Find the project root: the nearest ancestor containing `.git` or `.codify`,
 * falling back to the starting directory.
 */
export function findProjectRoot(start: string = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, ".codify"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function ensureDir(dir: string, mode?: number): string {
  fs.mkdirSync(dir, { recursive: true, mode });
  return dir;
}
