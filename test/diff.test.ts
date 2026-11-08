import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { changes, filePatch, fullPatch } from "../src/main/core/diff.ts";
import { parsePatch } from "../src/shared/diff.ts";

const repo = mkdtempSync(join(tmpdir(), "caboose-diff-"));
const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
after(() => rmSync(repo, { recursive: true, force: true }));

before(() => {
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "T");
  writeFileSync(join(repo, "keep.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "gone.txt"), "bye\n");
  writeFileSync(join(repo, "move.txt"), "a\nb\nc\nd\ne\n");
  sh("add", ".");
  sh("commit", "-q", "-m", "base");
  sh("switch", "-q", "-c", "work");
  // committed on the branch
  writeFileSync(join(repo, "committed.txt"), "new\n");
  sh("add", ".");
  sh("commit", "-q", "-m", "work");
  // uncommitted: modify, delete, rename, untracked text and binary
  writeFileSync(join(repo, "keep.txt"), "one\nTWO\nthree\nfour\n");
  unlinkSync(join(repo, "gone.txt"));
  renameSync(join(repo, "move.txt"), join(repo, "moved.txt"));
  sh("add", "-A", "move.txt", "moved.txt");
  writeFileSync(join(repo, "fresh.md"), "# hi\nthere\n");
  writeFileSync(join(repo, "blob.bin"), Buffer.from([1, 0, 2, 3]));
});

test("lists committed, uncommitted, renamed, deleted and untracked changes against the base", async () => {
  const c = await changes(repo, "main");
  assert.equal(c.base, sh("rev-parse", "main"));
  const byPath = Object.fromEntries(c.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ["blob.bin", "committed.txt", "fresh.md", "gone.txt", "keep.txt", "moved.txt"]);
  assert.equal(byPath["committed.txt"].status, "added");
  assert.equal(byPath["gone.txt"].status, "deleted");
  assert.deepEqual([byPath["keep.txt"].status, byPath["keep.txt"].additions, byPath["keep.txt"].deletions], ["modified", 2, 1]);
  assert.equal(byPath["moved.txt"].status, "renamed");
  assert.equal(byPath["moved.txt"].oldPath, "move.txt");
  assert.deepEqual([byPath["fresh.md"].status, byPath["fresh.md"].additions], ["untracked", 2]);
  assert.equal(byPath["blob.bin"].binary, true);
});

test("patches parse into numbered lines", async () => {
  const c = await changes(repo, "main");
  const keep = c.files.find((f) => f.path === "keep.txt")!;
  const hunks = parsePatch(await filePatch(repo, c.base, keep));
  assert.equal(hunks.length, 1);
  assert.deepEqual(
    hunks[0].lines.map((l) => `${l.type}:${l.old ?? ""}:${l.new ?? ""}:${l.text}`),
    ["ctx:1:1:one", "del:2::two", "add::2:TWO", "ctx:3:3:three", "add::4:four"],
  );
  const fresh = c.files.find((f) => f.path === "fresh.md")!;
  assert.deepEqual(
    parsePatch(await filePatch(repo, c.base, fresh))[0].lines.map((l) => [l.type, l.new, l.text]),
    [["add", 1, "# hi"], ["add", 2, "there"]],
  );
});

test("the full patch for Claude covers every file, or just one", async () => {
  const all = await fullPatch(repo, "main");
  assert.match(all, /keep\.txt/);
  assert.match(all, /\+# hi/);
  assert.match(all, /Binary file blob\.bin/);
  const one = await fullPatch(repo, "main", "keep.txt");
  assert.doesNotMatch(one, /fresh\.md/);
});

test("line marks: changed where lines were replaced, new where only added, a tick where only removed", async () => {
  const { lineMarks, parsePatch } = await import("../src/shared/diff.ts");
  const patch = [
    "@@ -1,8 +1,9 @@",
    " keep 1",
    "-old 2",
    "+changed 2",
    "+brand new 3",
    " keep 4",
    "-gone 5",
    " keep 6",
    "+added 7",
    "+added 8",
    " keep 9",
    " keep 10",
  ].join("\n");
  assert.deepEqual(lineMarks(parsePatch(patch)), {
    runs: [
      { from: 2, to: 2, kind: "modified" },
      { from: 3, to: 3, kind: "added" },
      { from: 6, to: 7, kind: "added" },
    ],
    removedBefore: [5],
  });
});
