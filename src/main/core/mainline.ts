// A repo's own Caboose files (.caboose/config.json, .caboose/running.sh) as
// they are on its main line: the remote's default branch (origin/HEAD, e.g.
// origin/master), read with `git show`, so neither the branch the main
// checkout happens to be on nor how long since it was pulled matters. Origin
// is fetched in the background, at most every 2 minutes per repo. Where origin
// has no such file (not pushed yet, or no origin at all), the main checkout's
// copy is used, as before.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TTL_MS = 60_000;
const FETCH_EVERY_MS = 120_000;

const cache = new Map<string, { at: number; value: string | null }>();
const refs = new Map<string, string | null>();
const fetchedAt = new Map<string, number>();

const gitSync = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 10_000 });

/** The remote's default branch as a ref (origin/master), or null when there is none. */
export function mainLineRef(root: string): string | null {
  if (refs.has(root)) return refs.get(root)!;
  let ref: string | null = null;
  try {
    ref = gitSync(root, "rev-parse", "--abbrev-ref", "origin/HEAD").trim() || null;
  } catch {
    for (const guess of ["origin/main", "origin/master"]) {
      try {
        gitSync(root, "rev-parse", "--verify", "--quiet", guess);
        ref = guess;
        break;
      } catch {
        // not this one
      }
    }
  }
  if (ref === "origin/HEAD") ref = null;
  refs.set(root, ref);
  return ref;
}

/** Fetches origin now and then, then forgets what was read so the next read is current. */
function fetchSometimes(root: string): void {
  if (Date.now() - (fetchedAt.get(root) ?? 0) < FETCH_EVERY_MS) return;
  fetchedAt.set(root, Date.now());
  execFile("git", ["fetch", "--quiet", "origin"], { cwd: root, windowsHide: true, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err) => {
    if (err) return;
    for (const key of cache.keys()) if (key.startsWith(`${root}\0`)) cache.delete(key);
  });
}

/** The file (path relative to the repo, "/"-separated) on the main line; null when it is not there. */
export function mainLineFile(root: string, rel: string): string | null {
  const key = `${root}\0${rel}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  fetchSometimes(root);
  const ref = mainLineRef(root);
  let value: string | null = null;
  if (ref) {
    try {
      value = gitSync(root, "show", `${ref}:${rel}`);
    } catch {
      value = null;
    }
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** The main line's copy, else the main checkout's own (not on origin yet, or no origin). */
export function repoFile(root: string, rel: string): { text: string; from: "main line" | "checkout" } | null {
  const main = mainLineFile(root, rel);
  if (main !== null) return { text: main, from: "main line" };
  const local = join(root, ...rel.split("/"));
  return existsSync(local) ? { text: readFileSync(local, "utf8"), from: "checkout" } : null;
}

/** Whether a feature's worktree changed the file since its branch left `baseRef` (committed or not). */
export async function changedInFeature(worktree: string, baseRef: string, rel: string): Promise<boolean> {
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) =>
      execFile("git", args, { cwd: worktree, windowsHide: true, timeout: 10_000 }, (err, out) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out) })),
    );
  const base = await run("merge-base", "HEAD", baseRef);
  if (base.code !== 0) return false;
  // Compares the start of the branch with the working tree: commits and uncommitted edits alike.
  const diff = await run("diff", "--quiet", base.out.trim(), "--", rel);
  if (diff.code === 1) return true;
  // A new file nobody has added yet is not in the diff.
  const status = await run("status", "--porcelain", "--", rel);
  return status.out.trim() !== "";
}

/** Forgets everything read (tests). */
export function forgetMainLine(): void {
  cache.clear();
  refs.clear();
  fetchedAt.clear();
}
