// One-time import from Conductor (macOS): its repos, each repo's "files to
// copy" rules and scripts, and the global create-PR prompt. Read-only; Caboose
// does not depend on Conductor afterwards. The repo-level rule files
// (.worktreeinclude, .conductor/*.toml) are also read for repos added by hand,
// on any OS.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConductorImport, ImportCandidate, RepoScripts } from "../../shared/types.ts";
import { parseToml, type TomlTable } from "./toml.ts";

export function conductorDbPath(home = homedir()): string {
  return process.env.CONDUCTOR_DB ?? join(home, "Library", "Application Support", "com.conductor.app", "conductor.db");
}

function readToml(file: string): TomlTable | null {
  if (!existsSync(file)) return null;
  try {
    return parseToml(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

/**
 * A repo's local-file patterns, in Conductor's order (first one found wins):
 * .worktreeinclude, file_include_globs in .conductor/settings.local.toml then
 * .conductor/settings.toml, the repo's globs in Conductor's DB, the global
 * ~/.conductor/settings.toml. Null when none of them says anything.
 */
export function conductorRules(root: string, opts: { dbGlobs?: string | null; home?: string } = {}): { patterns: string[]; from: string } | null {
  const sources: [string, () => string | null | undefined][] = [
    [".worktreeinclude", () => (existsSync(join(root, ".worktreeinclude")) ? readFileSync(join(root, ".worktreeinclude"), "utf8") : null)],
    [".conductor/settings.local.toml", () => readToml(join(root, ".conductor", "settings.local.toml"))?.file_include_globs as string],
    [".conductor/settings.toml", () => readToml(join(root, ".conductor", "settings.toml"))?.file_include_globs as string],
    ["Conductor's repo settings", () => opts.dbGlobs],
    ["~/.conductor/settings.toml", () => readToml(join(opts.home ?? homedir(), ".conductor", "settings.toml"))?.file_include_globs as string],
  ];
  for (const [from, read] of sources) {
    const text = read();
    if (typeof text === "string" && lines(text).length) return { patterns: lines(text), from };
  }
  return null;
}

/** A repo's scripts from Conductor: its DB columns, then [scripts] in .conductor/settings(.local).toml. */
export function conductorScripts(root: string, db: { setup?: string | null; run?: string | null; archive?: string | null } = {}): RepoScripts | undefined {
  const out: RepoScripts = {};
  const run: { name: string; command: string }[] = [];
  if (db.setup?.trim()) out.setup = db.setup.trim();
  if (db.archive?.trim()) out.archive = db.archive.trim();
  if (db.run?.trim()) run.push({ name: "run", command: db.run.trim() });
  for (const file of ["settings.toml", "settings.local.toml"]) {
    const scripts = readToml(join(root, ".conductor", file))?.scripts as TomlTable | undefined;
    if (!scripts) continue;
    if (typeof scripts.setup === "string" && scripts.setup.trim()) out.setup = scripts.setup.trim();
    if (typeof scripts.archive === "string" && scripts.archive.trim()) out.archive = scripts.archive.trim();
    if (typeof scripts.run === "string" && scripts.run.trim()) run.push({ name: "run", command: scripts.run.trim() });
    if (scripts.run && typeof scripts.run === "object" && !Array.isArray(scripts.run)) {
      for (const [name, def] of Object.entries(scripts.run as TomlTable)) {
        const command = (def as TomlTable)?.command;
        if (typeof command === "string" && command.trim() && !run.some((r) => r.name === name)) {
          // The default one first, so it is what "Run" runs.
          (def as TomlTable).default ? run.unshift({ name, command: command.trim() }) : run.push({ name, command: command.trim() });
        }
      }
    }
  }
  if (run.length) out.run = run;
  return Object.keys(out).length ? out : undefined;
}

type DbRepo = {
  name: string;
  root_path: string;
  file_include_globs?: string | null;
  setup_script?: string | null;
  run_script?: string | null;
  archive_script?: string | null;
};

/** What Conductor knows, ready to pick from. `configured` = paths already in Caboose's config. */
export function conductorImport(configured: Set<string>, opts: { dbPath?: string; home?: string } = {}): ConductorImport {
  const home = opts.home ?? homedir();
  const dbPath = opts.dbPath ?? conductorDbPath(home);
  if (!existsSync(dbPath)) return { available: false, repos: [] };
  // node:sqlite is built into Node 22.5+/Electron; required lazily so nothing else depends on it.
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rows: DbRepo[];
  try {
    const cols = new Set((db.prepare("PRAGMA table_info(repos)").all() as { name: string }[]).map((c) => c.name));
    const pick = (c: string) => (cols.has(c) ? c : `NULL AS ${c}`);
    rows = db
      .prepare(
        `SELECT name, root_path, ${pick("file_include_globs")}, ${pick("setup_script")}, ${pick("run_script")}, ${pick("archive_script")}
         FROM repos WHERE ${cols.has("hidden") ? "COALESCE(hidden, 0) = 0" : "1"} ORDER BY name`,
      )
      .all() as DbRepo[];
  } finally {
    db.close();
  }
  const seenPaths = new Set<string>();
  const repos: ImportCandidate[] = [];
  for (const r of rows) {
    if (!r.root_path || seenPaths.has(r.root_path)) continue; // the same checkout added twice
    seenPaths.add(r.root_path);
    const exists = existsSync(r.root_path);
    const rules = exists ? conductorRules(r.root_path, { dbGlobs: r.file_include_globs, home }) : null;
    repos.push({
      name: r.name,
      path: r.root_path,
      exists,
      alreadyConfigured: configured.has(r.root_path),
      localFiles: rules?.patterns ?? [".env*"],
      rulesFrom: rules?.from ?? "Conductor's default (.env*)",
      scripts: exists ? conductorScripts(r.root_path, { setup: r.setup_script, run: r.run_script, archive: r.archive_script }) : undefined,
    });
  }
  const prompt = (readToml(join(home, ".conductor", "settings.toml"))?.prompts as TomlTable | undefined)?.create_pr;
  return { available: true, repos, prInstructions: typeof prompt === "string" && prompt.trim() ? prompt.trim() : undefined };
}
