// A repo's own Caboose files come from its main line (origin's default branch), not from whatever the checkout is on.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadRepoConfig } from "../src/main/core/config.ts";
import { changedInFeature, forgetMainLine, mainLineRef, repoFile } from "../src/main/core/mainline.ts";
import { readRunning, runningScript } from "../src/main/core/running.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-mainline-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const commitAll = (cwd: string, m: string) => (sh(cwd, "add", "-A"), sh(cwd, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", m));

// origin: main has the team's .caboose files.
const origin = join(tmp, "origin.git");
sh(tmp, "init", "-q", "--bare", "-b", "main", origin);
const team = join(tmp, "team");
sh(tmp, "clone", "-q", origin, team);
mkdirSync(join(team, ".caboose"), { recursive: true });
writeFileSync(join(team, ".caboose", "config.json"), JSON.stringify({ releaseStrategy: "tag" }));
writeFileSync(join(team, ".caboose", "running.sh"), "echo 'test shop_v1.2'\n");
commitAll(team, "caboose files");
sh(team, "push", "-q", "origin", "main");

// The user's main checkout, now on another branch with a different config of its own.
const main = join(tmp, "main");
sh(tmp, "clone", "-q", origin, main);
sh(main, "checkout", "-q", "-b", "experiment");
mkdirSync(join(main, ".caboose"), { recursive: true });
writeFileSync(join(main, ".caboose", "config.json"), JSON.stringify({ releaseStrategy: "merge" }));

test("config.json and running.sh as on origin's default branch, whatever the checkout is on", async () => {
  forgetMainLine();
  assert.equal(mainLineRef(main), "origin/main");
  assert.equal(loadRepoConfig(main).releaseStrategy, "tag", "the main line's, not the checkout's");
  assert.deepEqual(repoFile(main, ".caboose/running.sh"), { text: "echo 'test shop_v1.2'\n", from: "main line" });
  const report = await readRunning(main);
  assert.deepEqual(report?.versions, [{ component: "", env: "test", version: "shop_v1.2" }]);
});

test("without the file on origin (or without origin), the checkout's copy", () => {
  forgetMainLine();
  const lonely = join(tmp, "lonely");
  sh(tmp, "init", "-q", "-b", "main", lonely);
  mkdirSync(join(lonely, ".caboose"), { recursive: true });
  writeFileSync(join(lonely, ".caboose", "config.json"), JSON.stringify({ releaseStrategy: "merge" }));
  assert.equal(mainLineRef(lonely), null);
  assert.equal(loadRepoConfig(lonely).releaseStrategy, "merge");
  assert.equal(repoFile(main, ".caboose/nothing.sh"), null);
});

test("a feature that changed running.sh runs its own copy; one that did not, the main line's", async () => {
  forgetMainLine();
  const wt = join(tmp, "wt");
  sh(main, "worktree", "add", "-q", "-b", "caboose/oslo", wt, "origin/main");
  const feature = { worktree: wt, baseRef: "origin/main" };
  assert.equal(await changedInFeature(wt, "origin/main", ".caboose/running.sh"), false);
  assert.equal((await runningScript(main, feature))?.key, main, "unchanged: the main line's");
  writeFileSync(join(wt, ".caboose", "running.sh"), "echo 'test shop_v1.3'\n");
  assert.equal(await changedInFeature(wt, "origin/main", ".caboose/running.sh"), true, "an uncommitted edit counts");
  assert.deepEqual(await runningScript(main, feature), { key: wt, cwd: wt, text: "echo 'test shop_v1.3'\n" });
  assert.deepEqual((await readRunning(main, undefined, feature))?.versions, [{ component: "", env: "test", version: "shop_v1.3" }]);
  commitAll(wt, "a better running.sh");
  assert.equal(await changedInFeature(wt, "origin/main", ".caboose/running.sh"), true, "so does a commit");
});
