import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PathEscapeError, resolveInRoot, toRel } from "../src/util/paths.js";
import { makeTempDir } from "./helpers.js";

describe("resolveInRoot", () => {
  it("resolves paths inside the root", () => {
    const root = makeTempDir({ "src/a.ts": "" });
    expect(resolveInRoot(root, "src/a.ts")).toBe(path.join(root, "src/a.ts"));
    expect(resolveInRoot(root, "new/file.ts")).toBe(path.join(root, "new/file.ts"));
  });

  it("rejects traversal and outside absolute paths", () => {
    const root = makeTempDir();
    expect(() => resolveInRoot(root, "../etc/passwd")).toThrow(PathEscapeError);
    expect(() => resolveInRoot(root, "/etc/passwd")).toThrow(PathEscapeError);
  });

  it("rejects symlinks that point outside", () => {
    const root = makeTempDir();
    const outside = makeTempDir({ "secret.txt": "s" });
    fs.symlinkSync(outside, path.join(root, "link"));
    expect(() => resolveInRoot(root, "link/secret.txt")).toThrow(PathEscapeError);
  });

  it("toRel produces posix paths", () => {
    expect(toRel("/a", "/a/b/c.ts")).toBe("b/c.ts");
  });
});
