// Updating Caboose = pulling its own git checkout, reinstalling if the lock
// file changed, and rebuilding. The caller restarts the app afterwards.
import { spawn } from "node:child_process";
import type { UpdateInfo } from "../../shared/types.ts";
import { git } from "./run.ts";

export async function checkForUpdate(dir: string, fetch = true): Promise<UpdateInfo> {
  const branch = await git(dir, "branch", "--show-current");
  const commit = await git(dir, "rev-parse", "--short", "HEAD");
  const upstream = await git(dir, "rev-parse", "--abbrev-ref", "@{upstream}").catch(() => "");
  if (!upstream) return { branch, commit, behind: 0, ahead: 0, dirty: false, commits: [], note: "This checkout has no upstream branch." };
  if (fetch) await git(dir, "fetch", "--quiet");
  const [behind, ahead, status, log] = await Promise.all([
    git(dir, "rev-list", "--count", "HEAD..@{upstream}").then(Number),
    git(dir, "rev-list", "--count", "@{upstream}..HEAD").then(Number),
    git(dir, "status", "--porcelain", "--untracked-files=no"),
    git(dir, "log", "--format=%h %s", "HEAD..@{upstream}"),
  ]);
  return { branch, commit, behind, ahead, dirty: status.length > 0, commits: log.split("\n").filter(Boolean) };
}

/** Pulls (fast-forward only), runs `npm install` if the lock file changed, then builds. */
export async function update(dir: string, log: (line: string) => void): Promise<void> {
  const info = await checkForUpdate(dir, false);
  if (info.dirty) throw new Error("Caboose's checkout has uncommitted changes; update it by hand.");
  if (info.ahead) throw new Error("Caboose's checkout has local commits; update it by hand.");
  const before = await git(dir, "rev-parse", "HEAD");
  log(await git(dir, "pull", "--ff-only"));
  const changed = await git(dir, "diff", "--name-only", before, "HEAD");
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
