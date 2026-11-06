// The Files tab: what git sees in a worktree, and reading one file without leaving it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listFiles, readRepoFile } from "../src/main/core/files.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-files-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const repo = join(tmp, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "node_modules", "x"), { recursive: true });
execFileSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(join(repo, "node_modules", "x", "index.js"), "");
execFileSync("git", ["add", "."], { cwd: repo });
writeFileSync(join(repo, "new.md"), "# new\n"); // untracked
writeFileSync(join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(repo, "data.bin"), Buffer.from([1, 0, 2, 0]));
writeFileSync(join(tmp, "secret.txt"), "outside\n");
symlinkSync(join(tmp, "secret.txt"), join(repo, "link.txt"));

test("lists tracked and untracked files, not ignored ones", async () => {
  const { files, truncated } = await listFiles(repo);
  assert.deepEqual(files, [".gitignore", "data.bin", "link.txt", "logo.png", "new.md", "src/a.ts"]);
  assert.equal(truncated, false);
});

test("reads text, images and binaries, and never leaves the worktree", () => {
  assert.deepEqual(readRepoFile(repo, "src/a.ts"), { kind: "text", size: 20, text: "export const a = 1;\n" });
  assert.match((readRepoFile(repo, "logo.png") as { dataUrl: string }).dataUrl, /^data:image\/png;base64,/);
  assert.equal(readRepoFile(repo, "data.bin").kind, "binary");
  assert.throws(() => readRepoFile(repo, "../secret.txt"), /Not a path inside the repo/);
  assert.throws(() => readRepoFile(repo, join(tmp, "secret.txt")), /Not a path inside the repo/);
  assert.throws(() => readRepoFile(repo, "link.txt"), /points outside the repo/);
});
