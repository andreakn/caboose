// Which release carries a merged change, from the repo's tags.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { lowestPerStage, prefixOf, releasesOf, stageOf } from "../src/main/core/releases.ts";
import { formatStages, parseStages } from "../src/shared/stages.ts";

const STAGES = parseStages("release = *_v*\ntest = *_TEST_v*\n# a comment\nprod = *_PROD_v*");

test("stages from text, and back", () => {
  assert.deepEqual(STAGES.map((s) => s.name), ["release", "test", "prod"]);
  assert.equal(formatStages(STAGES), "release = *_v*\ntest = *_TEST_v*\nprod = *_PROD_v*");
});

test("a tag belongs to the last stage it matches; prefixes are what comes before the version", () => {
  assert.equal(stageOf("orders_v1.437", STAGES), "release");
  assert.equal(stageOf("orders_TEST_v1.436", STAGES), "test", "also matches *_v*, but test comes later");
  assert.equal(stageOf("orders_PROD_v1.435", STAGES), "prod");
  assert.equal(stageOf("something-else", STAGES), undefined);
  assert.equal(prefixOf("orderws_v1.335"), "orderws_");
  assert.equal(prefixOf("orders_TEST_v1.436"), "orders_TEST_");
  assert.equal(prefixOf("v2.10.3"), "");
});

test("the lowest tag per stage and per prefix (services tagged separately)", () => {
  const sorted = ["stockws_v1.004", "stockws_v1.005", "orderws_TEST_v1.335", "orderws_v1.335", "orderws_v1.336"];
  assert.deepEqual(lowestPerStage(sorted, STAGES), [
    { stage: "release", tags: ["stockws_v1.004", "orderws_v1.335"] },
    { stage: "test", tags: ["orderws_TEST_v1.335"] },
    { stage: "prod", tags: [] },
  ]);
});

const tmp = mkdtempSync(join(tmpdir(), "caboose-rel-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=T", ...a], { cwd: tmp, encoding: "utf8" }).trim();

test("from a real repo: tags cut after the merge carry it, earlier ones do not", async () => {
  sh("init", "-q", "-b", "main");
  sh("commit", "-q", "--allow-empty", "-m", "before");
  sh("tag", "shop_v1.112");
  sh("tag", "shop_PROD_v1.112");
  sh("commit", "-q", "--allow-empty", "-m", "the feature, squash-merged");
  const merge = sh("rev-parse", "HEAD");
  sh("commit", "-q", "--allow-empty", "-m", "after");
  sh("tag", "shop_v1.113");
  sh("tag", "shop_TEST_v1.113");
  sh("commit", "-q", "--allow-empty", "-m", "later");
  sh("tag", "shop_v1.114");
  assert.deepEqual(await releasesOf(tmp, merge, STAGES), [
    { stage: "release", tags: ["shop_v1.113"] },
    { stage: "test", tags: ["shop_TEST_v1.113"] },
    { stage: "prod", tags: [] },
  ]);
  assert.deepEqual(await releasesOf(tmp, merge, []), [], "no stages: not tracked");
});

test("deploy progress: per stage, how many repos with tag rules are tagged; repos without rules do not count", async () => {
  const { deployProgress } = await import("../src/shared/stages.ts");
  const p = deployProgress([
    { name: "shop", stages: ["release", "test", "prod"], release: [{ stage: "release", tags: ["shop_v1.114"] }, { stage: "test", tags: ["shop_TEST_v1.114"] }, { stage: "prod", tags: [] }] },
    { name: "reports", stages: ["release", "test", "prod"] }, // not merged yet
    { name: "docs" }, // no tag rules
  ]);
  assert.deepEqual(
    p.map((x) => [x.stage, x.done, x.total]),
    [
      ["release", 1, 2],
      ["test", 1, 2],
      ["prod", 0, 2],
    ],
  );
  assert.deepEqual(p[0].repos, [{ name: "shop", tagged: true, done: true }, { name: "reports", tagged: false, done: false }]);
});

test("a repo tab's deploy mark: the furthest stage reached, and a line per stage", async () => {
  const { repoDeploy, stageEmoji } = await import("../src/shared/stages.ts");
  assert.deepEqual([stageEmoji("release"), stageEmoji("test"), stageEmoji("staging"), stageEmoji("prod"), stageEmoji("live")], ["🏷", "🧪", "🧪", "🚀", "🚀"]);
  const stages = ["release", "test", "prod"];
  assert.deepEqual(repoDeploy({ name: "shop", stages }), { lines: ["🏷 release –", "🧪 test –", "🚀 prod –"] }, "not merged: nothing reached");
  const tagged = repoDeploy({ name: "shop", stages, release: [{ stage: "release", tags: ["shop_v1.2"] }, { stage: "test", tags: ["shop_TEST_v1.2"] }, { stage: "prod", tags: [] }] });
  assert.equal(tagged.reached, "test");
  assert.deepEqual(tagged.lines, ["🏷 release ✓ (shop_v1.2)", "🧪 test ✓ (shop_TEST_v1.2)", "🚀 prod –"]);
  // With a running.sh: tagged for prod is not enough.
  const running = repoDeploy({
    name: "shop",
    stages,
    release: [{ stage: "release", tags: ["v1"] }, { stage: "test", tags: ["t1"] }, { stage: "prod", tags: ["p1"] }],
    running: { versions: [{ component: "", env: "test", version: "t1", contains: true }, { component: "", env: "prod", version: "p0", contains: false }] },
  });
  assert.equal(running.reached, "test");
  assert.equal(running.lines[2], "🚀 prod – tagged, not running yet (p1)");
});
