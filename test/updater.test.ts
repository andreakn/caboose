import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyConfigInput, configView, jiraToken, loadLocalConfig, plainCodec, readLocalConfig, saveLocalConfig } from "../src/main/core/config.ts";
import { checkForUpdate, update } from "../src/main/core/updater.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-upd-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

test("an update check lists the commits waiting upstream and notices local edits", async () => {
  const origin = join(tmp, "origin");
  sh(tmp, "init", "-q", "-b", "main", origin);
  sh(origin, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "one");
  const clone = join(tmp, "clone");
  sh(tmp, "clone", "-q", origin, clone);
  sh(origin, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "two: new feature");

  const info = await checkForUpdate(clone);
  assert.equal(info.branch, "main");
  assert.equal(info.behind, 1);
  assert.match(info.commits[0], /two: new feature/);
  assert.equal(info.dirty, false);

  writeFileSync(join(clone, "x.txt"), "x");
  sh(clone, "add", "x.txt");
  assert.equal((await checkForUpdate(clone, false)).dirty, true);
});

test("config: defaults fill gaps, tokens are sealed and never shown to the window", () => {
  const sealed = { canEncrypt: true, encrypt: (x: string) => `E(${x})`, decrypt: (x: string) => x.slice(2, -1) };
  let stored = applyConfigInput({}, { branchPrefix: " mine ", bashPath: "", featuresRoot: "~/f", repos: [{ name: "web", path: "/code/web" }, { name: "", path: "" }], jira: { level: "required", site: "https://x.atlassian.net", token: "secret" } }, sealed);
  assert.deepEqual(stored.jira?.token, { enc: "E(secret)" });
  assert.equal(stored.repos?.length, 1);
  saveLocalConfig(tmp, stored);
  assert.deepEqual(readLocalConfig(tmp), stored);
  const resolved = loadLocalConfig(tmp);
  assert.equal(resolved.branchPrefix, "mine");
  assert.ok(!resolved.featuresRoot.startsWith("~"));
  assert.equal(jiraToken(resolved.jira, sealed), "secret");
  assert.deepEqual(configView(stored).jira, { level: "required", site: "https://x.atlassian.net", hasToken: true });
  // Saving without a token keeps it; null removes it; no keychain stores it plain.
  stored = applyConfigInput(stored, { ...configView(stored), jira: { level: "optional" } }, sealed);
  assert.deepEqual(stored.jira?.token, { enc: "E(secret)" });
  assert.equal(applyConfigInput(stored, { jira: { level: "off", token: null } }, sealed).jira?.token, undefined);
  assert.deepEqual(applyConfigInput({}, { jira: { level: "off", token: "t" } }, plainCodec).jira?.token, { plain: "t" });
});

test("update pulls, reinstalls when package.json changed, and builds", async () => {
  const origin = join(tmp, "app-origin");
  sh(tmp, "init", "-q", "-b", "main", origin);
  const pkg = (v: string) =>
    JSON.stringify({ name: "fake", version: v, private: true, scripts: { build: "node -e \"require('fs').writeFileSync('built.txt', 'yes')\"" } });
  writeFileSync(join(origin, "package.json"), pkg("1.0.0"));
  sh(origin, "add", ".");
  sh(origin, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "v1");
  const clone = join(tmp, "app-clone");
  sh(tmp, "clone", "-q", origin, clone);
  writeFileSync(join(origin, "package.json"), pkg("1.1.0"));
  sh(origin, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-am", "v1.1");

  assert.equal((await checkForUpdate(clone)).behind, 1);
  const log: string[] = [];
  await update(clone, (l) => log.push(l));
  assert.equal((await checkForUpdate(clone, false)).behind, 0);
  assert.ok(log.includes("$ npm install"), log.join("\n"));
  assert.ok(log.includes("$ npm run build"));
  assert.ok(existsSync(join(clone, "built.txt")));
});

test("a repo's friendly name is kept trimmed, and dropped when empty", () => {
  const stored = applyConfigInput(
    {},
    { repos: [{ name: "order-service", path: "/c/orders", label: "  Orders " }, { name: "shop", path: "/c/shop", label: "  " }] },
    { canEncrypt: false, encrypt: (s) => s, decrypt: (s) => s },
  );
  assert.deepEqual(stored.repos, [{ name: "order-service", path: "/c/orders", label: "Orders" }, { name: "shop", path: "/c/shop" }]);
});

test("a checkout that moved on since the app started: the commits are listed, and update rebuilds without pulling", async () => {
  const origin = join(tmp, "moved-origin");
  sh(tmp, "init", "-q", "-b", "main", origin);
  writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "fake", private: true, scripts: { build: "node -e \"require('fs').writeFileSync('built.txt', 'yes')\"" } }));
  sh(origin, "add", ".");
  sh(origin, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "-m", "v1");
  const clone = join(tmp, "moved-clone");
  sh(tmp, "clone", "-q", origin, clone);
  const running = sh(clone, "rev-parse", "HEAD");
  // Committed in the checkout itself while the app runs (and pushed): nothing to pull.
  sh(clone, "-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "v2: the new thing");
  sh(origin, "fetch", "-q", clone, "main:refs/heads/next"); // as if pushed: origin has it too
  sh(origin, "merge", "-q", "--ff-only", "next");

  const info = await checkForUpdate(clone, true, running);
  assert.equal(info.behind, 0);
  assert.equal(info.running, running.slice(0, 7));
  assert.equal(info.newer.length, 1);
  assert.match(info.newer[0], /v2: the new thing/);
  const log: string[] = [];
  await update(clone, (l) => log.push(l), running);
  assert.ok(!log.some((l) => l.includes("npm install")), "package.json did not change");
  assert.ok(log.includes("$ npm run build"));
  assert.equal((await checkForUpdate(clone, false, sh(clone, "rev-parse", "HEAD"))).newer.length, 0);
});

test("a home area is kept only as a point in the Nordics", () => {
  assert.deepEqual(applyConfigInput({}, { home: { lon: 10.39512, lat: 63.43049 } }, plainCodec).home, { lon: 10.395, lat: 63.43 });
  assert.equal("home" in applyConfigInput({}, { home: { lon: -70, lat: 40 } }, plainCodec), false);
  assert.equal("home" in applyConfigInput({}, { home: { lon: Number.NaN, lat: 60 } } as never, plainCodec), false);
});
