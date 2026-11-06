// Import from a fake Conductor: its SQLite DB and the rule files it reads.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { conductorImport, conductorRules, conductorScripts } from "../src/main/core/conductor.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-conductor-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

function repo(name: string, files: Record<string, string> = {}) {
  const dir = join(tmp, "code", name);
  mkdirSync(join(dir, ".conductor"), { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}

const home = join(tmp, "home");
mkdirSync(join(home, ".conductor"), { recursive: true });
writeFileSync(
  join(home, ".conductor", "settings.toml"),
  'file_include_globs = ".env\\n.env.local\\n**/appsettings.local.json\\n"\n\n[prompts]\ncreate_pr = "No ticket prefix.\\nState test status."\n',
);
const idp = repo("idp", { ".worktreeinclude": "# comment\n**/appsettings.local.json\n.env*\n" });
const bff = repo("bff", {
  ".conductor/settings.local.toml": 'file_include_globs = ".env\\n.env.brand.*\\n"\n[scripts]\nsetup = "npm ci"\n[scripts.run.dev]\ncommand = "npm run dev"\n[scripts.run.web]\ncommand = "npm run web"\ndefault = true\n',
});
const plain = repo("plain");

test("rules come from the first source that has any, in Conductor's order", () => {
  assert.deepEqual(conductorRules(idp, { home }), { patterns: ["**/appsettings.local.json", ".env*"], from: ".worktreeinclude" });
  assert.deepEqual(conductorRules(bff, { home }), { patterns: [".env", ".env.brand.*"], from: ".conductor/settings.local.toml" });
  assert.deepEqual(conductorRules(plain, { home, dbGlobs: "certs/\n" }), { patterns: ["certs/"], from: "Conductor's repo settings" });
  assert.equal(conductorRules(plain, { home })?.from, "~/.conductor/settings.toml");
  assert.equal(conductorRules(plain, { home: join(tmp, "nobody") }), null);
});

test("scripts: setup and named run scripts, the default one first", () => {
  assert.deepEqual(conductorScripts(bff), {
    setup: "npm ci",
    run: [
      { name: "web", command: "npm run web" },
      { name: "dev", command: "npm run dev" },
    ],
  });
  assert.deepEqual(conductorScripts(plain, { run: "make serve", setup: " " }), { run: [{ name: "run", command: "make serve" }] });
  assert.equal(conductorScripts(plain), undefined);
});

test("the import lists Conductor's repos with their rules, scripts and the PR prompt", () => {
  const dbPath = join(tmp, "conductor.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE repos (name TEXT, root_path TEXT, hidden INTEGER, file_include_globs TEXT, setup_script TEXT, run_script TEXT, archive_script TEXT)");
  const ins = db.prepare("INSERT INTO repos VALUES (?, ?, ?, ?, ?, ?, ?)");
  ins.run("idp", idp, 0, null, null, null, null);
  ins.run("bff", bff, 0, null, null, null, null);
  ins.run("bff-again", bff, 0, null, null, null, null);
  ins.run("gone", join(tmp, "code", "gone"), 0, null, null, null, null);
  ins.run("hidden", plain, 1, null, null, null, null);
  db.close();

  const r = conductorImport(new Set([idp]), { dbPath, home });
  assert.equal(r.available, true);
  assert.equal(r.prInstructions, "No ticket prefix.\nState test status.");
  assert.deepEqual(
    r.repos.map((x) => [x.name, x.exists, x.alreadyConfigured, x.rulesFrom]),
    [
      ["bff", true, false, ".conductor/settings.local.toml"],
      ["gone", false, false, "Conductor's default (.env*)"],
      ["idp", true, true, ".worktreeinclude"],
    ],
  );
  assert.equal(r.repos[0].scripts?.setup, "npm ci");
  assert.equal(conductorImport(new Set(), { dbPath: join(tmp, "none.db"), home }).available, false);
});
