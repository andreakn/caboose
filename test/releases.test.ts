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
  assert.equal(stageOf("cda_v1.437", STAGES), "release");
  assert.equal(stageOf("cda_TEST_v1.436", STAGES), "test", "also matches *_v*, but test comes later");
  assert.equal(stageOf("cda_PROD_v1.435", STAGES), "prod");
  assert.equal(stageOf("something-else", STAGES), undefined);
  assert.equal(prefixOf("cdsws_v1.335"), "cdsws_");
  assert.equal(prefixOf("cda_TEST_v1.436"), "cda_TEST_");
  assert.equal(prefixOf("v2.10.3"), "");
});

test("the lowest tag per stage and per prefix (services tagged separately)", () => {
  const sorted = ["cbsws_v1.004", "cbsws_v1.005", "cdsws_TEST_v1.335", "cdsws_v1.335", "cdsws_v1.336"];
  assert.deepEqual(lowestPerStage(sorted, STAGES), [
    { stage: "release", tags: ["cbsws_v1.004", "cdsws_v1.335"] },
    { stage: "test", tags: ["cdsws_TEST_v1.335"] },
    { stage: "prod", tags: [] },
  ]);
});

const tmp = mkdtempSync(join(tmpdir(), "caboose-rel-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=T", ...a], { cwd: tmp, encoding: "utf8" }).trim();

test("from a real repo: tags cut after the merge carry it, earlier ones do not", async () => {
  sh("init", "-q", "-b", "main");
  sh("commit", "-q", "--allow-empty", "-m", "before");
  sh("tag", "via_v1.112");
  sh("tag", "via_PROD_v1.112");
  sh("commit", "-q", "--allow-empty", "-m", "the feature, squash-merged");
  const merge = sh("rev-parse", "HEAD");
  sh("commit", "-q", "--allow-empty", "-m", "after");
  sh("tag", "via_v1.113");
  sh("tag", "via_TEST_v1.113");
  sh("commit", "-q", "--allow-empty", "-m", "later");
  sh("tag", "via_v1.114");
  assert.deepEqual(await releasesOf(tmp, merge, STAGES), [
    { stage: "release", tags: ["via_v1.113"] },
    { stage: "test", tags: ["via_TEST_v1.113"] },
    { stage: "prod", tags: [] },
  ]);
  assert.deepEqual(await releasesOf(tmp, merge, []), [], "no stages: not tracked");
});
