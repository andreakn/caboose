// Platforms: a feature delivered in waves, against real git repos (and a fake Jira).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ResolvedLocalConfig } from "../src/main/core/config.ts";
import { Features } from "../src/main/core/features.ts";
import { type Jira, readFeatureJira, writeFeatureJira } from "../src/main/core/jira.ts";
import { platformBlockers, platformBranch, platformText } from "../src/main/core/platforms.ts";
import { Store } from "../src/main/core/store.ts";
import type { PrDetails } from "../src/shared/github.ts";
import type { Feature, FeatureOverview, RepoOverview } from "../src/shared/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-plat-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=T", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function makeRepo(name: string) {
  const origin = join(tmp, "origins", name);
  sh(tmp, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "README.md"), `${name}\n`);
  sh(origin, "add", ".");
  sh(origin, "commit", "-q", "-m", "init");
  const clone = join(tmp, "code", name);
  sh(tmp, "clone", "-q", origin, clone);
  return { origin, clone };
}

let web: { origin: string; clone: string };
let api: { origin: string; clone: string };
let shop: { origin: string; clone: string };
before(() => {
  web = makeRepo("web");
  api = makeRepo("api");
  shop = makeRepo("shop");
});

const config = (over: Partial<ResolvedLocalConfig> = {}): ResolvedLocalConfig => ({
  featuresRoot: join(tmp, "features"),
  archiveRoot: join(tmp, "archive"),
  branchPrefix: "caboose",
  repos: [
    { name: "web", path: web.clone },
    { name: "api", path: api.clone },
    { name: "shop", path: shop.clone },
  ],
  jira: { level: "off" },
  defaultAgent: "claude",
  defaultMode: "bypassPermissions",
  lines: {},
  ...over,
});

const pr = (number: number, state: PrDetails["state"], mergeCommit?: string) => ({ number, url: `https://github.com/o/r/pull/${number}`, state, ...(mergeCommit ? { mergeCommit } : {}) }) as PrDetails;
const overview = (f: Feature, repos: Record<string, Partial<RepoOverview>>): FeatureOverview => ({
  id: f.id,
  progress: { done: 0, total: 0 },
  todosOpen: 0,
  errors: [],
  repos: f.repos.map((r) => ({ name: r.name, branch: r.branch, local: { uncommitted: 0, ahead: 0, aheadBase: 0, behindBase: 0, pushed: true }, pr: null, ...repos[r.name] })),
});

/** Commits on the worktree's branch, pushes it, and merges it into origin's main (as a PR merge would); the merge commit. */
function mergeOnOrigin(worktree: string, origin: string, file: string): string {
  writeFileSync(join(worktree, file), "change\n");
  sh(worktree, "add", ".");
  sh(worktree, "commit", "-q", "-m", `add ${file}`);
  const branch = sh(worktree, "branch", "--show-current");
  sh(worktree, "push", "-q", "origin", branch);
  sh(origin, "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch);
  return sh(origin, "rev-parse", "HEAD");
}

test("branch names carry the platform from the second on", () => {
  assert.equal(platformBranch("caboose", "voss", "ABC-2", 1), "caboose/ABC-2-voss");
  assert.equal(platformBranch("caboose", "voss", undefined, 3), "caboose/voss-p3");
});

test("a platform ends only when its work is merged or closed", () => {
  const f = { id: "f", repos: [{ name: "web", branch: "b1" }, { name: "api", branch: "b2" }, { name: "shop", branch: "b3" }] } as Feature;
  const ov = overview(f, {
    web: { pr: pr(7, "OPEN") },
    api: { pr: null, local: { uncommitted: 0, ahead: 2, aheadBase: 2, behindBase: 0, pushed: false } },
    shop: { pr: pr(9, "MERGED"), local: { uncommitted: 3, ahead: 0, aheadBase: 1, behindBase: 0, pushed: true } },
  });
  assert.deepEqual(platformBlockers(f, ov), [
    "web's PR #7 is still open: merge or close it",
    "api has 2 commit(s) on b2 that were never merged (no PR)",
    "shop has 3 uncommitted change(s)",
  ]);
  assert.deepEqual(platformBlockers(f, overview(f, { web: { pr: pr(7, "MERGED") }, api: { pr: pr(8, "CLOSED") }, shop: {} })), []);
});

test("the next platform: new branches in the same worktrees, leavers removed, joiners added, the old one kept", async () => {
  const store = new Store(join(tmp, "s1", "state.json"));
  const features = new Features(store, config(), join(tmp, "s1", "logs"));
  const made = await features.create({ repos: ["web", "api"], title: "Gift receipts" });
  assert.ok(made.ok, !made.ok ? made.error : "");
  const f = made.value;
  const [w, a] = f.repos;
  writeFileSync(join(f.folder, "plan.md"), "# Plan\n\n- [x] contracts\n");

  const open = await features.nextPlatform(f.id, { repos: ["web"] }, overview(f, { web: { pr: pr(1, "OPEN") } }), () => []);
  assert.ok(!open.ok && /Platform 1 is not finished: web's PR #1 is still open/.test(open.error));

  const merge = mergeOnOrigin(w.path, web.origin, "contracts.txt");
  const ov = overview(f, { web: { pr: pr(1, "MERGED", merge) }, api: { pr: null } });
  const r = await features.nextPlatform(f.id, { goal: "Refine data", repos: ["web", "shop"] }, ov, (repo) => (repo === "web" ? [{ name: "test", pattern: "*_TEST_v*" }] : []));
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.deepEqual(r.value, { n: 2, warnings: [] });

  const g = features.get(f.id)!;
  assert.equal(g.platform?.n, 2);
  assert.equal(g.platform?.goal, "Refine data");
  assert.deepEqual(
    g.repos.map((x) => [x.name, x.path, x.branch]),
    [
      ["web", w.path, `caboose/${f.name}-p2`],
      ["shop", join(f.folder, "shop"), `caboose/${f.name}-p2`],
    ],
    "web keeps its worktree (its chat's folder) on a new branch; shop joins",
  );
  assert.equal(sh(w.path, "branch", "--show-current"), `caboose/${f.name}-p2`);
  assert.ok(existsSync(join(w.path, "contracts.txt")), "the new branch starts from the base, which has platform 1's merge");
  assert.ok(!existsSync(a.path), "api left: its worktree is gone");
  assert.equal(sh(web.clone, "branch", "--list", w.branch), "", "the merged branch is deleted");

  const [p1] = g.platforms!;
  assert.equal(p1.n, 1);
  assert.deepEqual(p1.repos, [
    { name: "web", branch: w.branch, pr: { number: 1, url: "https://github.com/o/r/pull/1", state: "MERGED" } },
    { name: "api", branch: a.branch },
  ]);
  assert.deepEqual(p1.releases?.map((x) => [x.repo, x.mergeCommit, x.stages]), [["web", merge, ["test"]]], "its merged repo's releases are followed");
  assert.match(readFileSync(join(f.folder, "plan.md"), "utf8"), /- \[x\] contracts\n\n## Platform 2: Refine data\n/);
  const log = readFileSync(join(f.folder, "log.md"), "utf8");
  assert.match(log, /web · status: queued\n\nPlatform 2: Refine data\. New branch/);
  assert.match(log, /shop · status: queued\n\nJoins in platform 2/);
  assert.match(log, /Platform 1 ended; platform 2: Refine data starts with web, shop\./);

  assert.match(platformText(g), /It is on platform 2, whose goal is: Refine data\..*Earlier: platform 1: web #1 merged, api\./);
  assert.ok(features.setPlatformSuperseded(f.id, 1, true).ok);
  assert.equal(features.get(f.id)!.platforms![0].superseded, true);
  assert.ok(features.setPlatformSuperseded(f.id, 1, false).ok);
  assert.equal(features.get(f.id)!.platforms![0].superseded, undefined);
  assert.equal(features.setPlatformSuperseded(f.id, 2, true).ok, false, "only earlier platforms");
});

test("Jira: own subtasks per platform, or the old ones (and the task) back in progress", async () => {
  const created: string[] = [];
  const started: string[] = [];
  let next = 10;
  const fake = {
    issue: async (key: string) => ({ key, summary: "Gift receipts", status: "Done", type: "Task", url: "" }),
    createSubtask: async (parent: string, summary: string) => (created.push(`${parent}>${summary}`), `ABC-${next++}`),
    startProgress: async (key: string) => (started.push(key), "In Progress"),
  } as unknown as Jira;
  const store = new Store(join(tmp, "s2", "state.json"));
  const features = new Features(store, config({ jira: { level: "optional" } }), join(tmp, "s2", "logs"), () => fake);
  const made = await features.create({ repos: ["api"], jira: { key: "ABC-1" } });
  assert.ok(made.ok, !made.ok ? made.error : "");
  const f = made.value;
  assert.deepEqual(readFeatureJira(f.folder).subtasks, { api: "ABC-10" });

  const merge = mergeOnOrigin(f.repos[0].path, api.origin, "p1.txt");
  const own = await features.nextPlatform(f.id, { goal: "Remove old hacks", repos: ["api"], jira: "own" }, overview(f, { api: { pr: pr(3, "MERGED", merge) } }), () => []);
  assert.ok(own.ok, !own.ok ? own.error : "");
  assert.deepEqual(created.slice(1), ["ABC-1>api: Remove old hacks"]);
  assert.deepEqual(readFeatureJira(f.folder).subtasks, { api: "ABC-11" });
  assert.equal(features.get(f.id)!.repos[0].branch, `caboose/ABC-11-${f.name}-p2`, "the new subtask's key is in the branch");
  assert.equal(features.get(f.id)!.platforms![0].repos[0].jira, "ABC-10", "the old subtask stays with platform 1");

  const g = features.get(f.id)!;
  const merge2 = mergeOnOrigin(g.repos[0].path, api.origin, "p2.txt");
  const reuse = await features.nextPlatform(f.id, { repos: ["api"], jira: "reuse" }, overview(g, { api: { pr: pr(4, "MERGED", merge2) } }), () => []);
  assert.ok(reuse.ok, !reuse.ok ? reuse.error : "");
  assert.deepEqual(started, ["ABC-1", "ABC-11"]);
  assert.equal(created.length, 2, "no new subtask");
  assert.equal(features.get(f.id)!.repos[0].branch, `caboose/ABC-11-${f.name}-p3`);
  writeFeatureJira(f.folder, readFeatureJira(f.folder));
});
