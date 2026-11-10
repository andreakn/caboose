// The next release tag, the way the user's tagdeploy script cuts it, and tagging origin's base.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { nextTag, strategyOf, tagNextRelease, tagPlan, tagPrefixes } from "../src/main/core/tagging.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-tag-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("the next version: the minor bumped, zero padding kept, a patch dropped, ignored tags skipped", () => {
  const tags = ["orders_v1.004", "orders_v1.005", "orders_TEST_v1.005", "orders_v1.10", "stock_v2.099", "stock_v2.099.1", "orders_v11.001", "v3.0"];
  assert.deepEqual(nextTag(tags, "orders", ["orders_v11.001"]), { latest: "orders_v1.10", next: "orders_v1.11" }, "numeric, not text, order; a mistyped tag ignored");
  assert.deepEqual(nextTag(tags, "stock"), { latest: "stock_v2.099.1", next: "stock_v2.100" }, "the patch goes, the minor grows (past 99 too)");
  assert.deepEqual(nextTag(["a_v1.005", "a_v1.006"], "a", ["a_v1.007"]), { latest: "a_v1.006", next: "a_v1.008" }, "an ignored version is never produced");
  assert.equal(nextTag(tags, "nope"), null);
  assert.deepEqual(tagPrefixes(["stock_v2.099", "orders_TEST_v1.5", "orders_v1.10", "stock_v2.098", "v3.0"]), ["stock", "orders"], "stage tags are not release prefixes");
  assert.equal(strategyOf({ name: "x", path: "/x", releaseStrategy: "merge" }, { releaseStrategy: "tag" }), "merge", "this machine's setting wins");
  assert.equal(strategyOf(undefined, { releaseStrategy: "tag" }), "tag");
  assert.equal(strategyOf({ name: "bff", path: "/b" }, {}, "tag"), "tag", "the line's default");
  assert.equal(strategyOf({ name: "bff", path: "/b", releaseStrategy: "merge" }, {}, "tag"), "merge", "a repo's own setting beats its line's");
  assert.equal(strategyOf(undefined, { releaseStrategy: "merge" }, "tag"), "merge", "so does the repo's .caboose/config.json");
});

test("tagging: origin's base tip gets the next tag, only that tag is pushed, whatever the checkout is on", async () => {
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  const origin = join(tmp, "origin.git");
  sh(tmp, "init", "-q", "--bare", "-b", "main", origin);
  const a = join(tmp, "a");
  sh(tmp, "clone", "-q", origin, a);
  const commit = (m: string) => sh(a, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", m);
  commit("first");
  sh(a, "tag", "orders_v1.009");
  sh(a, "push", "-q", "origin", "main", "--tags");
  sh(a, "tag", "local_only_v1.0"); // never pushed by tagging
  // Someone else merges a PR into main.
  const b = join(tmp, "b");
  sh(tmp, "clone", "-q", origin, b);
  sh(b, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "Merge pull request #7");
  sh(b, "push", "-q", "origin", "main");
  // This checkout is on a feature branch and behind.
  sh(a, "checkout", "-q", "-b", "caboose/oslo");

  const plan = await tagPlan(a, "origin/main");
  assert.equal(plan.subject, "Merge pull request #7");
  assert.deepEqual(plan.prefixes.find((p) => p.prefix === "orders"), { prefix: "orders", latest: "orders_v1.009", next: "orders_v1.010" });
  const out = await tagNextRelease(a, "origin/main", "orders");
  assert.equal(out.tag, "orders_v1.010");
  assert.equal(sh(origin, "rev-parse", "orders_v1.010^{commit}"), sh(b, "rev-parse", "HEAD"), "on origin's main tip, not the checkout's HEAD");
  assert.equal(sh(origin, "tag", "--list", "local_only*"), "", "other local tags stay local");
  assert.equal(sh(a, "branch", "--show-current"), "caboose/oslo", "the checkout was not switched");
  await assert.rejects(tagNextRelease(a, "origin/main", "nope"), /No release tags with the prefix nope_v/);
});
