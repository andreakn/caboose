// What is actually running in each environment, as a repo's own script says.
// A tag starts a deploy, but an approval step or pods that will not start can
// keep the new code from running; `.caboose/running.sh` in the repo reports
// what runs now, one line per component (a moniker) and environment:
//
//   orders  test  orders_TEST_v1.437
//   orders  prod  orders_PROD_v1.430+build.12
//   test    shop_TEST_v2.1          (one component: the repo itself)
//
// A version starts with the git tag that made the release. Caboose finds that
// tag and asks git whether it contains a PR's merge commit, so the script
// knows nothing about features. The script is the one on the repo's main line
// (origin's default branch), run from the main checkout's folder with the
// user's own credentials (kubectl, VPN), in the background; a feature that
// changed running.sh itself runs its own copy, from its worktree.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunningVersion } from "../../shared/types.ts";
import { REPO_DIR } from "./config.ts";
import { changedInFeature, repoFile } from "./mainline.ts";
import { git } from "./run.ts";
import { findBash } from "./scripts.ts";

export const RUNNING_SCRIPT = `${REPO_DIR}/running.sh`;
const TIMEOUT_MS = 20_000;

/** The script's lines: `component env version`, or `env version` for a repo with one component (""). */
export function parseRunning(text: string): RunningVersion[] {
  return text.split(/\r?\n/).flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return [];
    const parts = line.split(/\s+/);
    if (parts.length === 2) return [{ component: "", env: parts[0], version: parts[1] }];
    if (parts.length === 3) return [{ component: parts[0], env: parts[1], version: parts[2] }];
    return [];
  });
}

/**
 * The tag a version starts with: the longest one followed by the end or by
 * something that cannot continue it (so v1.4 is not the tag of v1.43 or v1.4.1).
 */
export function tagOf(version: string, tags: string[]): string | undefined {
  let best: string | undefined;
  for (const t of tags) {
    if (!version.startsWith(t) || (best && best.length >= t.length)) continue;
    const next = version.charAt(t.length);
    if (next === "" || !/[0-9A-Za-z.]/.test(next)) best = t;
  }
  return best;
}

export type RunningReport = { versions: RunningVersion[]; error?: string };

/** A feature's worktree, when the script may be its own: it is, if the feature changed running.sh. */
export type FeatureCheckout = { worktree: string; baseRef: string };

/** The script to run and where: a feature's own changed copy, else the main line's (null when there is none). */
export async function runningScript(source: string, feature?: FeatureCheckout): Promise<{ key: string; cwd: string; text: string } | null> {
  if (feature && existsSync(join(feature.worktree, RUNNING_SCRIPT)) && (await changedInFeature(feature.worktree, feature.baseRef, RUNNING_SCRIPT))) {
    return { key: feature.worktree, cwd: feature.worktree, text: readFileSync(join(feature.worktree, RUNNING_SCRIPT), "utf8") };
  }
  const file = repoFile(source, RUNNING_SCRIPT);
  return file ? { key: source, cwd: source, text: file.text } : null;
}

/** Runs a repo's running.sh (null when it has none). Never throws: a failure is reported, not "nothing runs". */
export async function readRunning(source: string, bashPath?: string, feature?: FeatureCheckout): Promise<RunningReport | null> {
  const script = await runningScript(source, feature).catch(() => null);
  if (!script) return null;
  return runScriptText(script.cwd, script.text, bashPath);
}

/** Runs the script's text (as a temporary file) in `cwd`. */
async function runScriptText(cwd: string, text: string, bashPath?: string): Promise<RunningReport> {
  try {
    const dir = join(tmpdir(), "caboose-running");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${createHash("sha1").update(text).digest("hex").slice(0, 12)}.sh`);
    if (!existsSync(file)) writeFileSync(file, text);
    const bash = await findBash(bashPath);
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn(bash, [file], { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => {
        p.kill();
        reject(new Error(`${RUNNING_SCRIPT} took more than ${TIMEOUT_MS / 1000} s`));
      }, TIMEOUT_MS);
      p.on("error", (e) => (clearTimeout(timer), reject(e)));
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`${RUNNING_SCRIPT} exited with ${code}${stderr.trim() ? `: ${stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
      });
    });
    return { versions: parseRunning(out) };
  } catch (e) {
    return { versions: [], error: (e as Error).message };
  }
}

/** The versions with their tags found, and (given a merge commit) whether each contains it. */
export async function resolveRunning(source: string, versions: RunningVersion[], mergeCommit?: string): Promise<RunningVersion[]> {
  if (!versions.length) return versions;
  const list = async () => (await git(source, "tag", "--list")).split("\n").filter(Boolean);
  let tags = await list().catch(() => [] as string[]);
  // A release cut since the last fetch: fetch its tags once.
  if (versions.some((v) => !tagOf(v.version, tags))) {
    await git(source, "fetch", "--quiet", "--tags", "origin").catch(() => "");
    tags = await list().catch(() => tags);
  }
  return Promise.all(
    versions.map(async (v) => {
      const tag = tagOf(v.version, tags);
      if (!tag) return v;
      if (!mergeCommit) return { ...v, tag };
      const contains = await git(source, "merge-base", "--is-ancestor", mergeCommit, tag).then(
        () => true,
        () => false,
      );
      return { ...v, tag, contains };
    }),
  );
}

/** Running reports per repo checkout, for a minute (many features share a repo; the script is not free). */
export class RunningCache {
  private cache = new Map<string, { at: number; value: Promise<RunningReport | null> }>();
  private bashPath: () => string | undefined;

  constructor(bashPath: () => string | undefined = () => undefined) {
    this.bashPath = bashPath;
  }

  /** Cached per script that runs: the main line's per repo, a feature's own per worktree. */
  async get(source: string, fresh = false, feature?: FeatureCheckout): Promise<RunningReport | null> {
    const script = await runningScript(source, feature).catch(() => null);
    if (!script) return null;
    const key = `${script.key}\0${createHash("sha1").update(script.text).digest("hex")}`;
    const hit = this.cache.get(key);
    if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.value;
    const value = runScriptText(script.cwd, script.text, this.bashPath());
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}
