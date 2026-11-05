// Repo scripts (setup/archive) run through bash on every OS, so one
// caboose.json works everywhere. On Windows that is Git for Windows' bash,
// which Claude Code needs anyway.
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { run } from "./run.ts";

let cachedBash: string | undefined;

export async function findBash(configured?: string): Promise<string> {
  if (configured) return configured;
  if (cachedBash) return cachedBash;
  if (process.platform !== "win32") return (cachedBash = "bash");
  // git.exe lives in <Git>\cmd or <Git>\mingw64\bin; bash.exe in <Git>\bin.
  const gits = (await run("where", ["git"]).catch(() => "")).split(/\r?\n/).filter(Boolean);
  for (const g of gits) {
    for (const up of ["..", join("..", ".."), join("..", "..", "..")]) {
      const candidate = join(dirname(g), up, "bin", "bash.exe");
      if (existsSync(candidate)) return (cachedBash = candidate);
    }
  }
  for (const c of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) {
    if (existsSync(c)) return (cachedBash = c);
  }
  throw new Error("Could not find bash. Install Git for Windows, or set bashPath in caboose.local.json.");
}

/** Runs `command` in `cwd` through bash, appending output to `logFile`. Resolves with the exit code. */
export async function runScript(
  command: string,
  cwd: string,
  logFile: string,
  env: Record<string, string>,
  bashPath?: string,
): Promise<number> {
  const bash = await findBash(bashPath);
  mkdirSync(dirname(logFile), { recursive: true });
  const log = createWriteStream(logFile, { flags: "a" });
  log.on("error", () => {}); // a lost log line must not crash the app
  log.write(`$ ${command}\n`);
  return new Promise((resolve) => {
    const child = spawn(bash, ["-lc", command], { cwd, env: { ...process.env, ...env }, windowsHide: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on("error", (e) => {
      log.end(`\n${e.message}\n`);
      resolve(-1);
    });
    child.on("close", (code) => {
      log.end(`\n[exit ${code}]\n`);
      resolve(code ?? -1);
    });
  });
}
