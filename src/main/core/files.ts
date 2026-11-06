// A repo's files for the Files tab: what git sees (tracked, plus untracked
// files that are not ignored, so no node_modules or bin/), and one file's
// contents. Paths are always relative to the worktree and never leave it.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { FileContent } from "../../shared/types.ts";
import { git } from "./run.ts";

const MAX_FILES = 50_000;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const IMAGES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
};

/** Every file git sees in the worktree, sorted, "/"-separated on every OS. */
export async function listFiles(root: string): Promise<{ files: string[]; truncated: boolean }> {
  const out = await git(root, "ls-files", "--cached", "--others", "--exclude-standard", "-z");
  const all = [...new Set(out.split("\0").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
}

/** The file at `path` (relative) inside `root`, refusing anything outside it (.., absolute paths, symlinks out). */
export function readRepoFile(root: string, path: string): FileContent {
  if (isAbsolute(path) || path.split(/[\\/]/).includes("..")) throw new Error(`Not a path inside the repo: ${path}`);
  const full = resolve(root, path);
  const real = realpathSync(full);
  const rel = relative(realpathSync(root), real);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${path} points outside the repo.`);
  const size = statSync(real).size;
  const mime = IMAGES[extname(path).toLowerCase()];
  if (mime) {
    if (size > MAX_IMAGE) return { kind: "tooLarge", size };
    return { kind: "image", size, dataUrl: `data:${mime};base64,${readFileSync(real).toString("base64")}` };
  }
  if (size > MAX_TEXT) return { kind: "tooLarge", size };
  const buf = readFileSync(real);
  if (buf.subarray(0, 8000).includes(0)) return { kind: "binary", size };
  return { kind: "text", size, text: buf.toString("utf8") };
}
