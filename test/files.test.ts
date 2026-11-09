// The Files tab: what git sees in a worktree, and reading one file without leaving it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listDir, listFiles, readFileAt, readRepoFile } from "../src/main/core/files.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-files-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repo = join(tmp, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "node_modules", "x"), { recursive: true });
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
writeFileSync(join(repo, ".env"), "SECRET=1\n");
writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(repo, "node_modules", "x", "index.js"), "");
execFileSync("git", ["add", "."], { cwd: repo });
writeFileSync(join(repo, "new.md"), "# new\n"); // untracked
writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(repo, "data.bin"), Buffer.from([1, 0, 2, 0]));
writeFileSync(join(tmp, "secret.txt"), "outside\n");
symlinkSync(join(tmp, "secret.txt"), join(repo, "link.txt"));

test("lists tracked and untracked files, not ignored ones", async () => {
  const { files, truncated, ignored, ignoredDirs } = await listFiles(repo);
  assert.deepEqual(files, [".gitignore", "data.bin", "link.txt", "logo.png", "new.md", "src/a.ts"]);
  assert.equal(truncated, false);
  // What git ignores, apart: files one by one, folders as one entry (read when opened).
  assert.deepEqual(ignored, [".env"]);
  assert.deepEqual(ignoredDirs, ["node_modules"]);
  assert.deepEqual(listDir(repo, "node_modules"), { files: [], dirs: ["node_modules/x"], truncated: false });
  assert.deepEqual(listDir(repo, "node_modules/x"), { files: ["node_modules/x/index.js"], dirs: [], truncated: false });
  assert.throws(() => listDir(repo, "../"), /Not a path inside the repo/);
  assert.equal(readRepoFile(repo, ".env").kind, "text", "an ignored file opens like any other");
});

test("reads text, images and binaries, and never leaves the worktree", () => {
  assert.deepEqual(readRepoFile(repo, "src/a.ts"), { kind: "text", size: 20, text: "export const a = 1;\n" });
  assert.match((readRepoFile(repo, "logo.png") as { dataUrl: string }).dataUrl, /^data:image\/png;base64,/);
  assert.equal(readRepoFile(repo, "data.bin").kind, "binary");
  assert.throws(() => readRepoFile(repo, "../secret.txt"), /Not a path inside the repo/);
  assert.throws(() => readRepoFile(repo, join(tmp, "secret.txt")), /Not a path inside the repo/);
  assert.throws(() => readRepoFile(repo, "link.txt"), /points outside the repo/);
});

test("a file as it was at a commit: text, missing, refused outside the repo", async () => {
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "base"], { cwd: repo });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  assert.deepEqual(await readFileAt(repo, "HEAD", "src/a.ts"), { kind: "text", size: 20, text: "export const a = 1;\n" });
  assert.equal(await readFileAt(repo, "HEAD", "new.md"), null, "untracked: not in the commit");
  await assert.rejects(readFileAt(repo, "HEAD", "../secret.txt"), /Not a path inside the repo/);
});
