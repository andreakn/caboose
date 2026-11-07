// Updating Caboose = pulling its own git checkout, reinstalling if the lock
// file changed, and rebuilding. The caller restarts the app afterwards.
// The checkout can also be ahead of the running app without any pull (you
// pulled or committed in it by hand): then a rebuild and restart is the update.
import { spawn } from "node:child_process";
import type { UpdateInfo } from "../../shared/types.ts";
import { git } from "./run.ts";

/** Commits in the checkout since `running` (the commit the app started from). */
async function sinceRunning(dir: string, running?: string): Promise<string[]> {
  if (!running) return [];
  const log = await git(dir, "log", "--format=%h %s", `${running}..HEAD`).catch(() => "");
  return log.split("\n").filter(Boolean);
}

export async function checkForUpdate(dir: string, fetch = true, running?: string): Promise<UpdateInfo> {
  const branch = await git(dir, "branch", "--show-current");
  const commit = await git(dir, "rev-parse", "--short", "HEAD");
  const upstream = await git(dir, "rev-parse", "--abbrev-ref", "@{upstream}").catch(() => "");
  const newer = await sinceRunning(dir, running);
  const run = running ? { running: running.slice(0, 7) } : {};
  if (!upstream) return { branch, commit, behind: 0, ahead: 0, dirty: false, commits: [], newer, ...run, note: "This checkout has no upstream branch." };
  if (fetch) await git(dir, "fetch", "--quiet");
  const [behind, ahead, status, log] = await Promise.all([
    git(dir, "rev-list", "--count", "HEAD..@{upstream}").then(Number),
    git(dir, "rev-list", "--count", "@{upstream}..HEAD").then(Number),
    git(dir, "status", "--porcelain", "--untracked-files=no"),
    git(dir, "log", "--format=%h %s", "HEAD..@{upstream}"),
  ]);
  return { branch, commit, behind, ahead, dirty: status.length > 0, commits: log.split("\n").filter(Boolean), newer, ...run };
}

/**
 * Pulls (fast-forward only) when there is something to pull, runs `npm
 * install` if package.json or the lock file changed since the running app's
 * commit, then builds.
 */
export async function update(dir: string, log: (line: string) => void, running?: string): Promise<void> {
  const info = await checkForUpdate(dir, false, running);
  const before = running ?? (await git(dir, "rev-parse", "HEAD"));
  if (info.behind > 0) {
    if (info.dirty) throw new Error("Caboose's checkout has uncommitted changes; update it by hand.");
    if (info.ahead) throw new Error("Caboose's checkout has local commits; update it by hand.");
    log(await git(dir, "pull", "--ff-only"));
  }
  const changed = await git(dir, "diff", "--name-only", before, "HEAD").catch(() => "package.json");
  if (/^package(-lock)?\.json$/m.test(changed)) await npm(dir, ["install"], log);
  await npm(dir, ["run", "build"], log);
}

function npm(dir: string, args: string[], log: (line: string) => void): Promise<void> {
  log(`$ npm ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    // npm is a .cmd script on Windows, which Node only runs through a shell.
    const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: dir,
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.stdout.on("data", (d) => log(String(d).trimEnd()));
    child.stderr.on("data", (d) => log(String(d).trimEnd()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} failed (exit ${code})`))));
  });
}
