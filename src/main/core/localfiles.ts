// Local files: the gitignored files (.env, *.local.*, …) a repo needs to run,
// copied from its main checkout into each new worktree. Which ones is up to
// patterns per repo, in the gitignore style:
//   .env*            no slash: matches the file name at any depth
//   config/app.json  with a slash: a path from the repo root
//   certs/           a trailing slash: everything inside that folder
//   **               any number of folders;  * ? {a,b} as usual
//   !pattern         leaves out what an earlier pattern matched
// Only files git ignores are copied: tracked ones are in every worktree, and
// untracked-but-not-ignored ones are someone's work in progress, which would
// show up as changes in the feature.
import { spawn } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { git } from "./run.ts";

/** Used when a repo has no patterns of its own in the config. */
export const DEFAULT_LOCAL_FILES = [".env*", "*.local.*"];

/** Folders never searched: big, generated, or someone else's. */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".tox", "dist", "build", "out", "target",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".gradle", ".idea", "vendor", "Pods", "DerivedData",
]);
const MAX_ENTRIES = 200_000;

/** One gitignore-style pattern as a regular expression over "/"-separated paths. */
export function patternToRegExp(pattern: string): RegExp {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = `${p.replace(/\/+$/, "")}/**`;
  const anchored = p.includes("/");
  p = p.replace(/^\//, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      // "**/" = zero or more folders; a trailing "**" = everything below
      if (p[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = p.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${p
          .slice(i + 1, end)
          .split(",")
          .map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`);
}

/** Whether a repo-relative path is selected by the patterns (later "!" patterns win over earlier ones). */
export function selector(patterns: string[]): (rel: string) => boolean {
  const rules = patterns
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith("#"))
    .map((p) => ({ negate: p.startsWith("!"), re: patternToRegExp(p.replace(/^!/, "")) }));
  return (rel) => {
    let hit = false;
    for (const r of rules) if (r.re.test(rel)) hit = !r.negate;
    return hit;
  };
}

/** The repo's gitignored files that the patterns select, as "/"-separated paths from the repo root. */
export async function findLocalFiles(root: string, patterns: string[]): Promise<string[]> {
  return (await scanLocalFiles(root, patterns)).copy;
}

/** What the patterns select: the gitignored files to copy, and untracked matches skipped because git does not ignore them. */
export async function scanLocalFiles(root: string, patterns: string[]): Promise<{ copy: string[]; notIgnored: string[] }> {
  const select = selector(patterns);
  if (!patterns.some((p) => p.trim() && !p.trim().startsWith("!") && !p.trim().startsWith("#"))) return { copy: [], notIgnored: [] };
  const tracked = new Set((await git(root, "ls-files", "-z")).split("\0"));
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), r);
      } else if (e.isFile() && select(r) && !tracked.has(r)) {
        found.push(r);
      }
      // symlinks are left alone
    }
  };
  walk(root, "");
  const ignored = await gitIgnored(root, found);
  return {
    copy: found.filter((f) => ignored.has(f)).sort(),
    notIgnored: found.filter((f) => !ignored.has(f)).sort(),
  };
}

/** Which of the paths git ignores (git check-ignore, fed through stdin). */
function gitIgnored(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["check-ignore", "-z", "--stdin"], { cwd: root, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    // Exit 1 just means "none of them are ignored".
    child.on("close", (code) =>
      code === 0 || code === 1 ? resolve(new Set(out.split("\0").filter(Boolean))) : reject(new Error(`git check-ignore: ${err.trim()}`)),
    );
    child.stdin.end(`${paths.join("\0")}\0`);
  });
}

/** Copies the files (repo-relative, "/"-separated) from one checkout to another, overwriting. */
export function copyLocalFiles(from: string, to: string, files: string[]): void {
  for (const rel of files) {
    const native = rel.split("/").join(sep);
    const src = join(from, native);
    if (!lstatSync(src).isFile()) continue;
    mkdirSync(dirname(join(to, native)), { recursive: true });
    copyFileSync(src, join(to, native));
  }
}
