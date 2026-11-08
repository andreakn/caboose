// Features against real git repos (and a fake Jira).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ResolvedLocalConfig } from "../src/main/core/config.ts";
import { checkRepo, Features, scanRepos } from "../src/main/core/features.ts";
import type { Jira } from "../src/main/core/jira.ts";
import { Store } from "../src/main/core/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-feat-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** A repo with an origin, cloned into tmp/code/<name>. */
function makeRepo(name: string, files: Record<string, string>) {
  const origin = join(tmp, "origins", name);
  sh(tmp, "init", "-q", "-b", "main", origin);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(origin, f), c);
  sh(origin, "add", ".");
  sh(origin, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "init");
  const clone = join(tmp, "code", name);
  sh(tmp, "clone", "-q", origin, clone);
  return clone;
}

let web: string;
let api: string;
before(() => {
  const gitignore = ".env*\n*.local.*\nsetup.txt\n";
  web = makeRepo("web", {
    "README.md": "web\n",
    ".gitignore": gitignore,
    "caboose.json": JSON.stringify({ setup: "echo port=$CABOOSE_PORT > setup.txt", copy: [".env"] }),
  });
  writeFileSync(join(web, ".env"), "SECRET=1\n");
  api = makeRepo("api", { "README.md": "api\n", ".gitignore": gitignore });
});

function config(over: Partial<ResolvedLocalConfig> = {}): ResolvedLocalConfig {
  return {
    featuresRoot: join(tmp, "features"),
    archiveRoot: join(tmp, "archive"),
    branchPrefix: "caboose",
    repos: [{ name: "web", path: web }, { name: "api", path: api }],
    jira: { level: "off" },
    defaultAgent: "claude",
    defaultMode: "bypassPermissions",
    ...over,
  };
}

const settled = (store: Store) => () => store.get().features.every((f) => f.repos.every((r) => r.setup !== "running"));
async function until(fn: () => boolean) {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fn(), "timed out");
}

test("a feature is a station folder with a worktree per repo on fresh, untracked branches", async () => {
  const store = new Store(join(tmp, "s1", "state.json"));
  const features = new Features(store, config(), join(tmp, "s1", "logs"));
  const r = await features.create({ repos: ["web", "api"] });
  assert.ok(r.ok, !r.ok ? r.error : "");
  const f = r.value;
  assert.equal(f.folder, join(tmp, "features", f.name));
  assert.ok(existsSync(join(f.folder, ".context")));
  assert.deepEqual(f.repos.map((x) => [x.name, x.path, x.branch]), [
    ["web", join(f.folder, "web"), `caboose/${f.name}`],
    ["api", join(f.folder, "api"), `caboose/${f.name}`],
  ]);
  for (const x of f.repos) {
    assert.equal(sh(x.path, "branch", "--show-current"), x.branch);
    assert.equal(x.baseRef, "origin/main");
    assert.throws(() => sh(x.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "must not track origin/main");
  }
  assert.equal(readFileSync(join(f.folder, "web", ".env"), "utf8"), "SECRET=1\n");
  await until(settled(store));
  assert.equal(readFileSync(join(f.folder, "web", "setup.txt"), "utf8").trim(), `port=${f.port}`);
  assert.equal(features.scriptEnv(f.id, "api").CABOOSE_PORT, String(f.port + 10));
  assert.equal(features.scriptEnv(f.id).CABOOSE_FEATURE_PATH, f.folder);

  const second = await features.create({ repos: ["api"] });
  assert.ok(second.ok);
  assert.notEqual(second.value.name, f.name);
  assert.equal(second.value.port, f.port + 100);
});

test("repos can be added later; archive keeps branches and folder, restore brings worktrees back", async () => {
  const store = new Store(join(tmp, "s2", "state.json"));
  const features = new Features(store, config(), join(tmp, "s2", "logs"));
  const r = await features.create({ repos: ["api"] });
  assert.ok(r.ok);
  const add = await features.addRepo(r.value.id, "web");
  assert.ok(add.ok, !add.ok ? add.error : "");
  assert.equal((await features.addRepo(r.value.id, "web")).ok, false);
  await until(settled(store));
  const f = features.get(r.value.id)!;
  writeFileSync(join(f.folder, "api", "work.txt"), "wip\n");
  sh(join(f.folder, "api"), "add", "work.txt");
  sh(join(f.folder, "api"), "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "wip");

  assert.ok((await features.archive(f.id)).ok);
  assert.equal(existsSync(join(f.folder, "api")), false);
  assert.ok(existsSync(f.folder));
  assert.ok(sh(api, "branch", "--list", f.repos[0].branch));
  const back = await features.restore(f.id);
  assert.ok(back.ok, !back.ok ? back.error : "");
  assert.equal(readFileSync(join(f.folder, "api", "work.txt"), "utf8").replace(/\r\n/g, "\n"), "wip\n");
  await until(settled(store));
});

test("required Jira: no task, no feature; with one, each repo gets a subtask and the key in its branch", async () => {
  const created: string[] = [];
  let n = 100;
  const fake = {
    issue: async (key: string) => ({ key, summary: "Checkout v2", status: "To Do", type: "Story", url: "" }),
    createTask: async (_p: string, s: string) => (created.push(`task:${s}`), `NWP-${n++}`),
    createSubtask: async (parent: string, s: string) => (created.push(`${parent}>${s}`), `NWP-${n++}`),
  } as unknown as Jira;
  const store = new Store(join(tmp, "s3", "state.json"));
  const cfg = config({ jira: { level: "required", project: "NWP" } });
  const features = new Features(store, cfg, join(tmp, "s3", "logs"), () => fake);

  assert.equal((await features.create({ repos: ["web"] })).ok, false);
  const r = await features.create({ repos: ["web", "api"], jira: { key: "https://x.atlassian.net/browse/NWP-1" } });
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.deepEqual(created, ["NWP-1>web: Checkout v2", "NWP-1>api: Checkout v2"]);
  assert.equal(readFileSync(join(r.value.folder, "jira.txt"), "utf8"), "NWP-1\nweb: NWP-100\napi: NWP-101\n");
  assert.deepEqual(r.value.repos.map((x) => x.branch), [`caboose/NWP-100-${r.value.name}`, `caboose/NWP-101-${r.value.name}`]);

  const made = await features.create({ repos: ["api"], jira: { create: "Brand new" } });
  assert.ok(made.ok, !made.ok ? made.error : "");
  assert.deepEqual(features.jiraOf(made.value.id), { task: "NWP-102", subtasks: { api: "NWP-103" } });
  await until(settled(store));
});

test("linking a task later: each repo gets a subtask and its key in the branch, unless already pushed", async () => {
  let n = 7;
  const fake = {
    issue: async (key: string) => ({ key, summary: "Thing", status: "", type: "", url: "" }),
    createSubtask: async () => `NWP-${n++}`,
  } as unknown as Jira;
  const store = new Store(join(tmp, "s4", "state.json"));
  const features = new Features(store, config({ jira: { level: "optional" } }), join(tmp, "s4", "logs"), () => fake);
  const r = await features.create({ repos: ["api", "web"], title: "  Checkout v2 " });
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.equal(r.value.title, "Checkout v2");
  assert.equal(r.value.status, "active");
  assert.equal(r.value.repos[0].branch, `caboose/${r.value.name}`);
  // web gets pushed before the task is linked
  const web = r.value.repos[1];
  sh(web.path, "push", "-q", "-u", "origin", web.branch);

  assert.equal((await features.setTask(r.value.id, "nope")).ok, false);
  const linked = await features.setTask(r.value.id, "NWP-5");
  assert.ok(linked.ok, !linked.ok ? linked.error : "");
  assert.deepEqual(linked.value.created, ["NWP-7", "NWP-8"]);
  assert.deepEqual(linked.value.renamed.map((x) => [x.repo, x.to]), [["api", `caboose/NWP-7-${r.value.name}`]]);
  assert.deepEqual(linked.value.skipped, ["web"]);
  const api = features.get(r.value.id)!.repos[0];
  assert.equal(sh(api.path, "branch", "--show-current"), `caboose/NWP-7-${r.value.name}`);
  assert.deepEqual(features.jiraOf(r.value.id), { task: "NWP-5", subtasks: { api: "NWP-7", web: "NWP-8" } });

  assert.ok(features.setDetails(r.value.id, { status: "review", title: "" }).ok);
  assert.equal(features.get(r.value.id)!.status, "review");
  assert.equal(features.get(r.value.id)!.title, undefined);
  await until(settled(store));
});

test("scripts come from the config, with the repo's caboose.json adding to them", () => {
  const store = new Store(join(tmp, "s6", "state.json"));
  const cfg = config({
    repos: [
      { name: "web", path: web, scripts: { run: [{ name: "dev", command: "npm run dev" }] } },
      { name: "api", path: api, scripts: { setup: "dotnet restore", run: [{ name: "run", command: "dotnet run" }] } },
    ],
  });
  const features = new Features(store, cfg, join(tmp, "s6", "logs"));
  // web's caboose.json has a setup script and no run script
  assert.deepEqual(features.scriptsFor("web", web), { setup: "echo port=$CABOOSE_PORT > setup.txt", archive: undefined, run: [{ name: "dev", command: "npm run dev" }] });
  writeFileSync(join(api, "caboose.json"), JSON.stringify({ setup: "ignored: the config has one", run: "make serve" }));
  assert.deepEqual(features.scriptsFor("api", api), {
    setup: "dotnet restore",
    archive: undefined,
    run: [
      { name: "run", command: "dotnet run" },
      { name: "caboose.json", command: "make serve" },
    ],
  });
  rmSync(join(api, "caboose.json"));
});

test("local files: each repo's patterns pick the gitignored files to bring; copy again overwrites", async () => {
  // In the main checkouts: gitignored files of different kinds.
  writeFileSync(join(web, ".env.local"), "WEB_LOCAL=1\n");
  writeFileSync(join(web, "app.local.yaml"), "x: 1\n");
  writeFileSync(join(api, ".env"), "API=1\n");
  writeFileSync(join(api, "secrets.local.json"), "{}\n");
  const store = new Store(join(tmp, "s5", "state.json"));
  const cfg = config({
    repos: [
      { name: "web", path: web }, // no patterns: the defaults (.env*, *.local.*), plus caboose.json's ".env"
      { name: "api", path: api, localFiles: [".env", "!*.local.*"] },
    ],
  });
  const features = new Features(store, cfg, join(tmp, "s5", "logs"));
  const r = await features.create({ repos: ["web", "api"] });
  assert.ok(r.ok, !r.ok ? r.error : "");
  const [w, a] = r.value.repos;
  assert.deepEqual(w.copied, [".env", ".env.local", "app.local.yaml"]);
  assert.deepEqual(a.copied, [".env"]);
  assert.ok(existsSync(join(w.path, "app.local.yaml")));
  assert.equal(existsSync(join(a.path, "secrets.local.json")), false);

  writeFileSync(join(api, ".env"), "API=2\n");
  const again = await features.copyLocalFilesAgain(r.value.id, "api");
  assert.ok(again.ok && again.value.join() === ".env");
  assert.equal(readFileSync(join(a.path, ".env"), "utf8"), "API=2\n");
  await until(settled(store));
});

test("a feature can start with no repos and get them later", async () => {
  const store = new Store(join(tmp, "s7", "state.json"));
  const features = new Features(store, config(), join(tmp, "s7", "logs"));
  const r = await features.create({ title: "Just an idea" });
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.deepEqual(r.value.repos, []);
  assert.ok(existsSync(r.value.folder));
  assert.ok((await features.addRepo(r.value.id, "api")).ok);
  await until(settled(store));
});

test("repos are found by folder and by scanning a parent folder", async () => {
  const c = await checkRepo(join(web));
  assert.ok(c.ok && c.value.name === "web");
  assert.equal((await checkRepo(tmp)).ok, false);
  assert.deepEqual(scanRepos(join(tmp, "code")).map((r) => r.name), ["api", "web"]);
});

test("lines: a feature never mixes them; repos on no line go anywhere; a feature takes its first repo's line", async () => {
  const store = new Store(join(tmp, "s9", "state.json"));
  // web is a customer's, api is on no line, mine is on the Personal line (same checkout, another name).
  const repos = [
    { name: "web", path: web, line: "Varner" },
    { name: "api", path: api },
    { name: "mine", path: api, line: "Personal" },
  ];
  const features = new Features(store, config({ repos }), join(tmp, "s9", "logs"));

  const a = await features.create({ title: "No line chosen" });
  assert.ok(a.ok);
  assert.ok((await features.addRepo(a.value.id, "api")).ok, "a repo on no line keeps the feature on no line");
  assert.equal(features.get(a.value.id)?.line, undefined);
  assert.ok((await features.addRepo(a.value.id, "web")).ok);
  assert.equal(features.get(a.value.id)?.line, "Varner", "taken from its first repo on a line");
  const mixed = await features.addRepo(a.value.id, "mine");
  assert.ok(!mixed.ok && /mine is on the Personal line, and this feature is on Varner/.test(mixed.error));

  const b = await features.create({ line: "Personal", repos: ["web"] });
  assert.ok(!b.ok && /web is on the Varner line/.test(b.error));
  const c = await features.create({ line: "Personal" });
  assert.ok(c.ok && c.value.line === "Personal");
  assert.ok(!features.setDetails(a.value.id, { line: "Personal" }).ok, "web is in it, and on Varner");
  assert.ok(features.setDetails(c.value.id, { line: null }).ok);
  assert.equal(features.get(c.value.id)?.line, undefined);
  await until(settled(store));
});
