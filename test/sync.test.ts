// Pull and "merge the base" from a repo row: what is behind is fetched and
// counted, merges that conflict are undone and name the files.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GitHub } from "../src/main/core/github.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-sync-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const clone = (name: string) => {
  const p = join(tmp, name);
  sh(tmp, "clone", "-q", origin, p);
  sh(p, "config", "user.email", "t@e");
  sh(p, "config", "user.name", "T");
  return p;
};
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-q", "-m", `${file}: ${text}`);
};

const origin = join(tmp, "origin.git");
sh(tmp, "init", "-q", "--bare", "-b", "main", origin);
const other = clone("other"); // a teammate, or GitHub's merge button
commit(other, "a.txt", "base\n");
sh(other, "push", "-q", "origin", "main");
const ws = clone("ws");
sh(ws, "switch", "-q", "--no-track", "-c", "caboose/finse", "origin/main");
commit(ws, "b.txt", "mine\n");
sh(ws, "push", "-q", "-u", "origin", "caboose/finse");

test("pull fast-forwards what was pushed to the branch elsewhere", async () => {
  sh(other, "fetch", "-q");
  sh(other, "switch", "-q", "caboose/finse");
  commit(other, "c.txt", "theirs\n");
  sh(other, "push", "-q", "origin", "caboose/finse");
  const gh = new GitHub();
  assert.equal((await gh.branchStatus(ws, "origin/main")).behind, 1, "fetched and counted");
  assert.deepEqual(await gh.pull(ws), { conflicts: [] });
  assert.equal(readFileSync(join(ws, "c.txt"), "utf8").replace(/\r\n/g, "\n"), "theirs\n");
  assert.equal((await gh.branchStatus(ws, "origin/main")).behind, 0);
});

test("merging the base brings in what landed there (a squash-merged PR, say)", async () => {
  sh(other, "switch", "-q", "main");
  commit(other, "d.txt", "on main\n");
  sh(other, "push", "-q", "origin", "main");
  const gh = new GitHub();
  assert.deepEqual(await gh.mergeBase(ws, "origin/main"), { conflicts: [] }, "merging always fetches first");
  assert.ok(existsSync(join(ws, "d.txt")));
  const s = await gh.branchStatus(ws, "origin/main");
  assert.equal(s.behindBase, 0);
  assert.equal(s.ahead, 2, "the merge and what it brought in are there to push");
});

test("a merge that conflicts is undone, and names the files", async () => {
  commit(other, "a.txt", "main's version\n");
  sh(other, "push", "-q", "origin", "main");
  commit(ws, "a.txt", "my version\n");
  const r = await new GitHub().mergeBase(ws, "origin/main");
  assert.deepEqual(r, { conflicts: ["a.txt"] });
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "my version\n");
  assert.equal(sh(ws, "status", "--porcelain"), "", "no merge left half-done");
});

test("uncommitted changes in the way: git's own message", async () => {
  commit(other, "e.txt", "new on main\n");
  sh(other, "push", "-q", "origin", "main");
  writeFileSync(join(ws, "e.txt"), "untracked here\n");
  await assert.rejects(new GitHub().mergeBase(ws, "origin/main"), /e\.txt/);
});
