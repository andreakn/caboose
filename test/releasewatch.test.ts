// Following features as they ship: announced once per stage, also after they have ended.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ReleaseWatch, type ReleaseNews } from "../src/main/core/releasewatch.ts";
import { Store } from "../src/main/core/store.ts";
import type { Feature, FeatureOverview, StationVisit } from "../src/shared/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-rw-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=T", ...a], { cwd: tmp, encoding: "utf8" }).trim();
const STAGES = [{ name: "release", pattern: "*_v*" }, { name: "prod", pattern: "*_PROD_v*" }];

test("stages reached are announced once, the first look only remembers, ended features keep shipping", async () => {
  sh("init", "-q", "-b", "main");
  sh("commit", "-q", "--allow-empty", "-m", "merged feature");
  const merge = sh("rev-parse", "HEAD");
  sh("tag", "via_v1.1");

  const store = new Store(join(tmp, "state.json"));
  const live = { id: "live", name: "bodo", repos: [], archived: false } as unknown as Feature;
  const visit: StationVisit = {
    station: "tinglev", featureId: "ended", repos: ["via"], createdAt: "", endedAt: "", ended: "archived", merged: true,
    releases: [{ repo: "via", source: tmp, mergeCommit: merge, stages: ["release", "prod"], release: [] }],
  };
  store.update((s) => ({ ...s, features: [live], visits: [visit] }));
  let liveOv: FeatureOverview = { id: "live", progress: { done: 0, total: 0 }, repos: [{ name: "cda", branch: "b", stages: ["release", "prod"], release: [{ stage: "release", tags: ["cda_v1"] }, { stage: "prod", tags: [] }] }], errors: [] };
  const news: ReleaseNews[] = [];
  const w = new ReleaseWatch({ store, overview: async () => liveOv, stagesFor: () => STAGES, announce: (n) => news.push(n) });

  assert.deepEqual(await w.check(), [], "the first look announces nothing that had already happened");
  assert.deepEqual(store.get().releaseNews?.sort(), ["ended:release", "live:release"]);
  assert.deepEqual(store.get().visits[0].releases?.[0].release, [{ stage: "release", tags: ["via_v1.1"] }, { stage: "prod", tags: [] }], "the ended feature's tags were read again");

  // Later: the ended feature reaches prod, the live one too.
  sh("tag", "via_PROD_v1.1");
  liveOv = { ...liveOv, repos: [{ ...liveOv.repos[0], release: [{ stage: "release", tags: ["cda_v1"] }, { stage: "prod", tags: ["cda_PROD_v1"] }] }] };
  await w.check();
  assert.deepEqual(news.map((n) => `${n.station}:${n.stage}`).sort(), ["bodo:prod", "tinglev:prod"]);
  assert.deepEqual(await w.check(), [], "nothing is announced twice");
});
