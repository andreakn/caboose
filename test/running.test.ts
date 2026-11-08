// What runs where: a repo's .caboose/running.sh, its versions matched to release tags, and progress from them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadRepoConfig } from "../src/main/core/config.ts";
import { parseRunning, readRunning, resolveRunning, tagOf } from "../src/main/core/running.ts";
import { runnables } from "../src/main/core/runscripts.ts";
import { deployProgress, relevantVersions } from "../src/shared/stages.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-running-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("the script's lines: component, environment, version; or environment and version for a one-component repo", () => {
  assert.deepEqual(parseRunning("# what runs\norders  test  orders_TEST_v1.437\n\norders prod orders_PROD_v1.430+build.12\r\ntest shop_TEST_v2.1\nnot a line at all here\n"), [
    { component: "orders", env: "test", version: "orders_TEST_v1.437" },
    { component: "orders", env: "prod", version: "orders_PROD_v1.430+build.12" },
    { component: "", env: "test", version: "shop_TEST_v2.1" },
  ]);
});

test("a version's tag is the longest one it starts with that it does not continue", () => {
  const tags = ["orders_v1.4", "orders_v1.43", "orders_TEST_v1.437", "v2"];
  assert.equal(tagOf("orders_TEST_v1.437", tags), "orders_TEST_v1.437");
  assert.equal(tagOf("orders_TEST_v1.437-5-gabc123", tags), "orders_TEST_v1.437");
  assert.equal(tagOf("orders_v1.43+build.7", tags), "orders_v1.43");
  assert.equal(tagOf("orders_v1.4_20261108", tags), "orders_v1.4");
  assert.equal(tagOf("orders_v1.44", tags), undefined, "v1.4 is not the tag of v1.44");
  assert.equal(tagOf("orders_v1.4.1", tags), undefined);
  assert.equal(tagOf("v2", tags), "v2");
});

test("a real running.sh in a real repo: versions found as tags, and whether they have a merged change", async () => {
  const repo = join(tmp, "shop");
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" }).trim();
  mkdirSync(join(repo, ".caboose"), { recursive: true });
  sh("init", "-q", "-b", "main");
  const commit = (msg: string) => (sh("-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", msg), sh("rev-parse", "HEAD"));
  commit("start");
  sh("tag", "orders_PROD_v1.1");
  const merge = commit("the feature's merge commit");
  sh("tag", "orders_TEST_v1.2");
  assert.equal(await readRunning(repo), null, "no script: nothing to say");

  writeFileSync(join(repo, ".caboose", "running.sh"), "echo 'orders test orders_TEST_v1.2-3-gabc'\necho 'orders prod orders_PROD_v1.1'\necho 'orders dev 9.9.9'\n");
  const report = await readRunning(repo);
  assert.equal(report?.error, undefined);
  const versions = await resolveRunning(repo, report!.versions, merge);
  assert.deepEqual(versions, [
    { component: "orders", env: "test", version: "orders_TEST_v1.2-3-gabc", tag: "orders_TEST_v1.2", contains: true },
    { component: "orders", env: "prod", version: "orders_PROD_v1.1", tag: "orders_PROD_v1.1", contains: false },
    { component: "orders", env: "dev", version: "9.9.9" },
  ]);
  assert.deepEqual((await resolveRunning(repo, report!.versions)).map((v) => v.contains), [undefined, undefined, undefined], "before a merge: versions only");

  writeFileSync(join(repo, ".caboose", "running.sh"), "echo 'cannot reach the cluster' >&2; exit 4\n");
  const failed = await readRunning(repo);
  assert.deepEqual(failed?.versions, []);
  assert.match(failed!.error!, /exited with 4: cannot reach the cluster/);
});

test("progress: where a repo reports what runs, running counts; tagged but not running is pending; other repos count by tags", () => {
  const v = (component: string, env: string, contains?: boolean) => ({ component, env, version: `${component}_${env}`, ...(contains !== undefined ? { contains } : {}) });
  const repos = [
    // Tagged for test and prod, but prod still runs the old release (an approval, or pods that do not start).
    {
      name: "shop",
      stages: ["release", "test", "prod"],
      release: [{ stage: "release", tags: ["a"] }, { stage: "test", tags: ["b"] }, { stage: "prod", tags: ["c"] }],
      running: { versions: [v("orders", "test", true), v("orders", "prod", false), v("stock", "prod", false)] },
      components: ["orders"],
    },
    // No running.sh: its tags are what there is.
    { name: "web", stages: ["release", "test", "prod"], release: [{ stage: "release", tags: ["d"] }, { stage: "test", tags: ["e"] }, { stage: "prod", tags: [] }] },
  ];
  const p = Object.fromEntries(deployProgress(repos).map((x) => [x.stage, x]));
  assert.deepEqual(Object.keys(p), ["release", "test", "prod"]);
  assert.deepEqual([p.test.done, p.test.total, p.test.pending], [2, 2, 0]);
  assert.deepEqual([p.prod.done, p.prod.total, p.prod.pending], [0, 2, 1], "shop is tagged for prod but does not run it");
  assert.deepEqual(p.prod.repos[0], { name: "shop", tagged: true, running: false, done: false });
  assert.deepEqual(relevantVersions(repos[0].running, ["orders"]).map((x) => x.component), ["orders", "orders"], "stock is not this feature's");
  // An environment only the script knows is a stage too.
  assert.deepEqual(deployProgress([{ name: "x", running: { versions: [v("", "staging", true)] } }]).map((x) => [x.stage, x.done]), [["staging", 1]]);
});

test("a repo's .caboose folder: its config, and run scripts there run from the root (the root's win)", () => {
  const repo = join(tmp, "tidy");
  mkdirSync(join(repo, ".caboose"), { recursive: true });
  writeFileSync(join(repo, ".caboose", "config.json"), JSON.stringify({ setup: "npm ci" }));
  writeFileSync(join(repo, "caboose.json"), JSON.stringify({ setup: "old" }));
  assert.equal(loadRepoConfig(repo).setup, "npm ci", ".caboose/config.json first");
  writeFileSync(join(repo, ".caboose", "run_orders.sh"), "# url: http://localhost:4000/\nnode orders.js\n");
  writeFileSync(join(repo, ".caboose", "run.sh"), "echo inner\n");
  writeFileSync(join(repo, "run.sh"), "echo root\n");
  const list = runnables(repo);
  assert.deepEqual(
    list.map((s) => [s.id, s.label, s.command]),
    [
      ["run.sh", "run", "bash run.sh"],
      [".caboose/run_orders.sh", "orders", "bash .caboose/run_orders.sh"],
    ],
  );
  assert.deepEqual(list[1].urls, [{ url: "http://localhost:4000/" }]);
  assert.equal(runnables(repo, [{ name: "orders", command: "./.caboose/run_orders.sh" }]).length, 2, "a configured script calling it is that script");
});
