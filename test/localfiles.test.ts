import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { copyLocalFiles, DEFAULT_LOCAL_FILES, findLocalFiles, scanLocalFiles, selector } from "../src/main/core/localfiles.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-local-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("patterns work like .gitignore", () => {
  const s = (patterns: string[], path: string) => selector(patterns)(path);
  assert.ok(s([".env*"], ".env"));
  assert.ok(s([".env*"], "apps/web/.env.local"));
  assert.ok(!s([".env*"], "apps/web/my.env"));
  assert.ok(s(["*.local.*"], "config/app.local.json"));
  assert.ok(!s(["*.local.*"], "config/app.json"));
  assert.ok(s(["config/app.json"], "config/app.json"));
  assert.ok(!s(["config/app.json"], "x/config/app.json"), "a slash anchors to the root");
  assert.ok(s(["/secrets.json"], "secrets.json"));
  assert.ok(s(["certs/"], "certs/dev/key.pem"));
  assert.ok(s(["apps/**/.env"], "apps/.env"));
  assert.ok(s(["apps/**/.env"], "apps/a/b/.env"));
  assert.ok(s(["*.{pem,key}"], "certs/dev.key"));
  assert.ok(s(["?.txt"], "a.txt") && !s(["?.txt"], "ab.txt"));
  assert.ok(!s([".env*", "!.env.example"], ".env.example"), "! leaves out");
  assert.ok(s([".env*", "!.env.*", ".env.local"], ".env.local"), "later rules win");
  assert.ok(!s(["# comment", ""], ".env"));
});

test("only gitignored matches are found, and big folders are skipped", async () => {
  const repo = join(tmp, "repo");
  const files: Record<string, string> = {
    ".env.example": "tracked",
    "config/app.json": "tracked",
    ".env": "A=1",
    ".envrc": "use nix",
    "apps/web/.env.local": "B=2",
    "config/app.local.json": "{}",
    "node_modules/pkg/.env": "skip me",
    "notes.txt": "untracked but not matched",
    "draft.local.md": "untracked, matched, but not ignored",
    ".gitignore": ".env\n.env.*\n!.env.example\n.envrc\n*.local.*\n!draft.local.md\nnode_modules/\n",
  };
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), c);
  }
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", ".gitignore", ".env.example", "config/app.json"], { cwd: repo });

  assert.deepEqual(await findLocalFiles(repo, DEFAULT_LOCAL_FILES), [".env", ".envrc", "apps/web/.env.local", "config/app.local.json"]);
  assert.deepEqual(await findLocalFiles(repo, [".env*", "!.envrc"]), [".env", "apps/web/.env.local"]);
  assert.deepEqual(await findLocalFiles(repo, []), []);
  assert.deepEqual((await scanLocalFiles(repo, DEFAULT_LOCAL_FILES)).notIgnored, ["draft.local.md"]);

  const to = join(tmp, "copy");
  copyLocalFiles(repo, to, [".env", "apps/web/.env.local"]);
  assert.deepEqual(await findLocalFiles(to, [".env*"]).catch(() => "not a repo"), "not a repo");
  execFileSync("git", ["init", "-q"], { cwd: to });
  writeFileSync(join(to, ".gitignore"), ".env*\n");
  assert.deepEqual(await findLocalFiles(to, [".env*"]), [".env", "apps/web/.env.local"]);
});
