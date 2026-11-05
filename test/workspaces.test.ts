// node --test: exercises the real git CLI against throwaway repos.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Store } from "../src/main/core/store.ts";
import { Workspaces } from "../src/main/core/workspaces.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-test-"));
const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

let origin: string;
let clone: string;

before(() => {
  // An "origin" with one commit on main, and a clone of it as the user's main checkout.
  origin = join(tmp, "origin");
  sh(tmp, "init", "-q", "-b", "main", origin);
  sh(origin, "config", "user.email", "t@example.com");
  sh(origin, "config", "user.name", "T");
  writeFileSync(join(origin, "README.md"), "hi\n");
  writeFileSync(
    join(origin, "caboose.json"),
    JSON.stringify({ setup: "echo set up in $CABOOSE_WORKSPACE_NAME > setup.txt", copy: [".env"] }),
  );
  sh(origin, "add", ".");
  sh(origin, "commit", "-q", "-m", "init");
  clone = join(tmp, "my-repo");
  sh(tmp, "clone", "-q", origin, clone);
  writeFileSync(join(clone, ".env"), "SECRET=1\n");
});

after(() => rmSync(tmp, { recursive: true, force: true }));

// One service for the whole file, like the app has.
let svc: { store: Store; ws: Workspaces };
const service = () =>
  (svc ??= (() => {
    const store = new Store(join(tmp, "data", "state.json"));
    const config = { workspacesRoot: join(tmp, "workspaces"), branchPrefix: "me" };
    return { store, ws: new Workspaces(store, config, join(tmp, "data", "logs")) };
  })());

const settled = (store: Store) => () => store.get().workspaces.every((w) => w.setup !== "running");

async function until(fn: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("adding a repo finds its root and origin's default branch", async () => {
  const { ws } = service();
  const r = await ws.addRepo(join(clone)); // from the root
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.equal(r.value.name, "my-repo");
  assert.equal(r.value.baseRef, "origin/main");
  const again = await ws.addRepo(clone);
  assert.ok(again.ok && again.value.id === r.value.id, "adding twice returns the same repo");
});

test("a folder outside git is refused", async () => {
  const { ws } = service();
  const r = await ws.addRepo(tmp);
  assert.equal(r.ok, false);
});

test("a workspace is a worktree on a fresh, untracked branch with copied files and setup run", async () => {
  const { ws, store } = service();
  const repo = store.get().repos[0];
  const r = await ws.createWorkspace(repo.id);
  assert.ok(r.ok, !r.ok ? r.error : "");
  const w = r.value;
  assert.match(w.branch, /^me\/[a-z0-9-]+$/);
  assert.equal(sh(w.path, "branch", "--show-current"), w.branch);
  assert.equal(sh(w.path, "rev-parse", "HEAD"), sh(clone, "rev-parse", "origin/main"));
  assert.throws(() => sh(w.path, "rev-parse", "--abbrev-ref", "@{upstream}"), "must not track origin/main");
  assert.equal(readFileSync(join(w.path, ".env"), "utf8"), "SECRET=1\n");
  assert.ok(existsSync(join(w.path, ".context")));
  writeFileSync(join(w.path, ".context", "note.md"), "x");
  await until(() => store.get().workspaces.find((x) => x.id === w.id)?.setup !== "running");
  assert.equal(store.get().workspaces.find((x) => x.id === w.id)?.setup, "ok", ws.setupLog(w.id));
  assert.equal(readFileSync(join(w.path, "setup.txt"), "utf8").trim(), `set up in ${w.name}`);
  assert.doesNotMatch(sh(w.path, "status", "--porcelain"), /\.context/);
});

test("two workspaces get different names", async () => {
  const { ws, store } = service();
  const repo = store.get().repos[0];
  const r = await ws.createWorkspace(repo.id);
  assert.ok(r.ok, !r.ok ? r.error : "");
  await until(settled(store));
  const names = store.get().workspaces.map((w) => w.name);
  assert.equal(new Set(names).size, names.length);
});

test("each workspace gets its own block of ports, also in its scripts", () => {
  const { ws, store } = service();
  const ports = store.get().workspaces.map((w) => w.port);
  assert.deepEqual(ports, [41000, 41010]);
  assert.equal(ws.scriptEnv(store.get().workspaces[1].id).CABOOSE_PORT, "41010");
});

test("archive removes the worktree but keeps the branch; restore brings it back", async () => {
  const { ws, store } = service();
  const w = store.get().workspaces[0];
  writeFileSync(join(w.path, "work.txt"), "wip\n");
  sh(w.path, "add", "work.txt");
  sh(w.path, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "wip");
  const a = await ws.archiveWorkspace(w.id);
  assert.ok(a.ok, !a.ok ? a.error : "");
  assert.equal(existsSync(w.path), false);
  assert.equal(store.get().workspaces[0].archived, true);
  assert.ok(sh(clone, "branch", "--list", w.branch));
  const r = await ws.restoreWorkspace(w.id);
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.equal(readFileSync(join(w.path, "work.txt"), "utf8"), "wip\n");
  assert.equal(store.get().workspaces[0].archived, false);
  await until(settled(store));
  assert.equal(store.get().workspaces[0].setup, "ok");
});

test("state survives a restart", () => {
  const { store } = service();
  const reloaded = new Store(join(tmp, "data", "state.json"));
  assert.deepEqual(reloaded.get(), store.get());
});

test("a repo with live workspaces cannot be removed", async () => {
  const { ws, store } = service();
  const r = ws.removeRepo(store.get().repos[0].id);
  assert.equal(r.ok, false);
});
