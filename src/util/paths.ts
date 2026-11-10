import fs from "node:fs";
import path from "node:path";

export class PathEscapeError extends Error {}

/**
 * Resolve a model-supplied path inside `root`, rejecting anything that
 * escapes it (`..`, absolute paths elsewhere, symlinks pointing outside).
 */
export function resolveInRoot(root: string, p: string): string {
  const absRoot = path.resolve(root);
  const target = path.resolve(absRoot, p);
  assertInside(absRoot, target, p);
  // Canonicalise the deepest existing ancestor to catch symlink escapes.
  let probe = target;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  if (fs.existsSync(probe)) {
    const realRoot = fs.realpathSync(absRoot);
    assertInside(realRoot, fs.realpathSync(probe), p);
  }
  return target;
}

function assertInside(root: string, target: string, original: string): void {
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new PathEscapeError(`Path escapes the project root: ${original}`);
  }
}

/** Project-relative POSIX path for display and citations. */
export function toRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join("/");
}
