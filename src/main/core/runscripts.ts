// The programs a repo can run, as cross_conductor found them: run.sh and
// run_<moniker>.sh at the root of its checkout (one per program), plus the
// run scripts in the config / caboose.json. A script that serves a website
// declares its URL in a comment, for a 🌐 button:
//   # url: http://localhost:15081/customer-data-api/ swagger
// Without url lines, a localhost URL in the script's header comment counts.
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RepoScripts, RunUrl } from "../../shared/types.ts";

export const RUN_SCRIPT_RE = /^run(?:_([A-Za-z0-9][A-Za-z0-9._-]*))?\.sh$/;
const URL_RE = /^#\s*url:\s*(https?:\/\/\S+)(?:\s+(.+?))?\s*$/i;
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s,;'"()<>]*)?/g;

/** One program a repo can run. `id` is the script's file name, or `config:<name>` for configured ones. */
export type RunnableScript = { id: string; label: string; moniker?: string; command: string; urls: RunUrl[] };

export function declaredUrls(text: string): RunUrl[] {
  const lines = text.slice(0, 8192).split("\n").map((l) => l.trim());
  const explicit = lines.flatMap((l) => {
    const m = l.match(URL_RE);
    return m ? [{ url: m[1], ...(m[2] ? { label: m[2] } : {}) }] : [];
  });
  if (explicit.length) return explicit;
  const header: string[] = [];
  for (const l of lines.slice(lines[0]?.startsWith("#!") ? 1 : 0)) {
    if (!l.startsWith("#")) break;
    header.push(l);
  }
  const found = header.join("\n").match(LOCAL_URL_RE) ?? [];
  return [...new Set(found.map((u) => u.replace(/[.:]+$/, "")))].map((url) => ({ url }));
}

/** run.sh / run_*.sh at the root of a checkout, and the configured run scripts that are not one of them. */
export function runnables(path: string, configured: RepoScripts["run"] = []): RunnableScript[] {
  let files: string[] = [];
  try {
    files = existsSync(path) ? readdirSync(path) : [];
  } catch {
    // unreadable: nothing to run
  }
  const scripts = files
    .filter((f) => RUN_SCRIPT_RE.test(f) && statSync(join(path, f)).isFile())
    .sort()
    .map((file): RunnableScript => {
      const moniker = file.match(RUN_SCRIPT_RE)?.[1];
      let text = "";
      try {
        text = readFileSync(join(path, file), "utf8");
      } catch {
        // no URLs then
      }
      return { id: file, label: moniker ?? "run", ...(moniker ? { moniker } : {}), command: commandFor(path, file), urls: declaredUrls(text) };
    });
  // A configured script that only calls one of those files is that file (Conductor's run actions often are).
  const sameFile = (command: string) => command.trim().match(/^(?:\.\/|(?:ba)?sh\s+)?(run(?:_[A-Za-z0-9._-]+)?\.sh)$/)?.[1];
  const fromConfig = configured
    .filter((s) => !scripts.some((x) => x.id === sameFile(s.command)))
    .map((s): RunnableScript => ({ id: `config:${s.name}`, label: s.name, command: s.command, urls: [] }));
  return [...scripts, ...fromConfig];
}

/** `./run_x.sh` when it is executable, else `bash run_x.sh` (Windows has no executable bit). */
function commandFor(path: string, file: string): string {
  if (process.platform === "win32") return `bash ${file}`;
  try {
    accessSync(join(path, file), constants.X_OK);
    return `./${file}`;
  } catch {
    return `bash ${file}`;
  }
}

/** One line of a moniker file: short name, the repo's main checkout, a description. */
export type Moniker = { moniker: string; path: string; description: string };

let cache: { file: string; mtime: number; entries: Moniker[] } | null = null;

/**
 * The user's moniker file (cross_conductor's, the one their shell's `z` uses):
 *   moniker   path   description      (path relative to the file's folder, or ~/…; # comments)
 * Re-read when it changes.
 */
export function readMonikers(file: string | undefined): Moniker[] {
  if (!file || !existsSync(file)) return [];
  const mtime = statSync(file).mtimeMs;
  if (cache?.file === file && cache.mtime === mtime) return cache.entries;
  const entries = parseMonikers(readFileSync(file, "utf8"), dirname(file));
  cache = { file, mtime, entries };
  return entries;
}

export function parseMonikers(text: string, base: string): Moniker[] {
  const out: Moniker[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([^#\s]\S*)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const path = m[2].startsWith("~/") ? join(homedir(), m[2].slice(2)) : resolve(base, m[2]);
    out.push({ moniker: m[1], path: path.replace(/[\\/]$/, ""), description: m[3]?.trim() ?? "" });
  }
  return out;
}

/** A repo's moniker (the first entry for its main checkout) and the descriptions of every moniker, for labels. */
export function monikersOf(entries: Moniker[], source: string): { moniker?: string; description?: string; describe: (m?: string) => string | undefined } {
  const clean = real(source);
  const mine = entries.find((e) => e.path === clean || real(e.path) === clean);
  const byName = new Map(entries.map((e) => [e.moniker.toLowerCase(), e.description]));
  return {
    ...(mine ? { moniker: mine.moniker, description: mine.description || undefined } : {}),
    // run.sh is the repo's own program; run_x.sh is described by moniker x.
    describe: (m) => (m ? byName.get(m.toLowerCase()) : mine?.description) || undefined,
  };
}

/** The path with symlinks resolved (/tmp → /private/tmp), so the file and the config may name it differently. */
function real(p: string): string {
  const clean = p.replace(/[\\/]$/, "");
  try {
    return realpathSync(clean);
  } catch {
    return resolve(clean);
  }
}
