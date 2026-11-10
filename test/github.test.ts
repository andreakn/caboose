import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GitHub, normalizePr } from "../src/main/core/github.ts";
import { checksSummary, createPrMessage } from "../src/shared/github.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-gh-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

const origin = join(tmp, "origin.git");
const ws = join(tmp, "ws");
sh(tmp, "init", "-q", "--bare", "-b", "main", origin);
sh(tmp, "clone", "-q", origin, ws);
sh(ws, "config", "user.email", "t@e");
sh(ws, "config", "user.name", "T");
sh(ws, "commit", "-q", "--allow-empty", "-m", "base");
sh(ws, "push", "-q", "origin", "main");
sh(ws, "switch", "-q", "--no-track", "-c", "caboose/finse", "origin/main");

test("branch status counts uncommitted files and unpushed commits, before and after pushing", async () => {
  const gh = new GitHub();
  writeFileSync(join(ws, "a.txt"), "a");
  sh(ws, "add", "a.txt");
  sh(ws, "commit", "-q", "-m", "a");
  writeFileSync(join(ws, "b.txt"), "b");
  let s = await gh.branchStatus(ws, "origin/main");
  assert.deepEqual(s, { head: "caboose/finse", uncommitted: 1, upstream: undefined, ahead: 1, behind: 0, behindBase: 0, aheadBase: 1 });

  await gh.push(ws, "caboose/finse");
  s = await gh.branchStatus(ws, "origin/main");
  assert.equal(s.upstream, "origin/caboose/finse");
  assert.equal(s.ahead, 0);
});

test("a branch can be renamed while unpushed, and bad names are refused", async () => {
  const gh = new GitHub();
  sh(ws, "switch", "-q", "-c", "caboose/myrdal");
  await gh.renameBranch(ws, "caboose/myrdal", "caboose/better-name");
  assert.equal(sh(ws, "branch", "--show-current"), "caboose/better-name");
  await assert.rejects(gh.renameBranch(ws, "caboose/better-name", "bad..name"));
});

test("GitHub is off for repos whose origin is elsewhere", async () => {
  const s = await new GitHub().status(ws, "caboose/finse", "origin/main");
  assert.equal(s.available, false);
});

test("PRs and their checks are read from gh, checks from both GitHub APIs", async () => {
  const calls: string[][] = [];
  const raw = {
    number: 7, url: "https://github.com/a/b/pull/7", title: "T", state: "OPEN", isDraft: false,
    mergeable: "MERGEABLE", reviewDecision: "", baseRefName: "main",
    statusCheckRollup: [
      { __typename: "CheckRun", name: "build", workflowName: "CI", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "u1" },
      { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "u2" },
      { __typename: "CheckRun", name: "lint", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "StatusContext", context: "vercel", state: "PENDING", targetUrl: "u3" },
    ],
  };
  const gh = new GitHub(async (file, args) => {
    calls.push([file, ...args]);
    return JSON.stringify([raw]);
  });
  const pr = (await gh.pr(ws, "caboose/finse"))!;
  assert.deepEqual(calls[0].slice(0, 5), ["gh", "pr", "list", "--head", "caboose/finse"]);
  assert.deepEqual(pr.checks.map((c) => [c.name, c.state]), [
    ["CI / build", "success"], ["test", "failure"], ["lint", "pending"], ["deploy", "skipped"], ["vercel", "pending"],
  ]);
  assert.deepEqual(checksSummary(pr.checks), { failed: 1, pending: 2, passed: 1 });
  assert.equal(normalizePr({ ...raw, statusCheckRollup: undefined } as never).checks.length, 0);

  await gh.merge(ws, 7, "squash");
  assert.deepEqual(calls[1], ["gh", "pr", "merge", "7", "--squash"]);
});

test("the create-PR message names the branch and the base", () => {
  const m = createPrMessage("web", "caboose/finse", "origin/main", true, "ABC-9");
  assert.match(m, /the web\/ folder/);
  assert.match(m, /git push -u origin caboose\/finse/);
  assert.match(m, /gh pr create --base main --draft/);
  assert.match(m, /Jira issue ABC-9/);
  assert.doesNotMatch(m, /start the title/);
  assert.doesNotMatch(createPrMessage("web", "b", "origin/main", false), /Jira/);
});

test("one message asks the feature's chat for a PR in each repo with work", async () => {
  const { createPrsMessage } = await import("../src/shared/github.ts");
  const m = createPrsMessage(
    [
      { repo: "shop-api", branch: "caboose/ABC-2-oslo", baseRef: "origin/main", jiraKey: "ABC-2" },
      { repo: "web", branch: "caboose/oslo", baseRef: "origin/develop" },
    ],
    true,
    "Imperative titles.",
  );
  assert.match(m, /^Open a draft pull request for each of these repos/);
  assert.match(m, /- shop-api: branch caboose\/ABC-2-oslo, base main, Jira ABC-2\n- web: branch caboose\/oslo, base develop\n/);
  assert.match(m, /gh pr create --base <base> --draft/);
  assert.match(m, /in which order they should be merged/);
  assert.match(m, /How I want PRs written:\nImperative titles\./);
});

test("Fix CI: what fails, how to find out why, and re-running what is not the change's fault", async () => {
  const { fixCiMessage } = await import("../src/shared/github.ts");
  const one = fixCiMessage([{ repo: "shop-api", pr: 12, checks: [{ name: "build / test", url: "https://github.com/o/r/actions/runs/1" }] }]);
  assert.match(one, /^CI fails on PR #12 of the shop-api repo \(the shop-api\/ folder\):\n- build \/ test \(https:\/\/github.com\/o\/r\/actions\/runs\/1\)\n/);
  assert.match(one, /gh run view <run-id> --log-failed/);
  assert.match(one, /gh run rerun <run-id> --failed/);
  const two = fixCiMessage([
    { repo: "shop-api", pr: 12, checks: [{ name: "build" }] },
    { repo: "web", pr: 7, checks: [{ name: "lint" }, { name: "e2e" }] },
  ]);
  assert.match(two, /^CI fails on these PRs of the feature/);
  assert.match(two, /shop-api, PR #12:\n {2}- build\nweb, PR #7:\n {2}- lint\n {2}- e2e\n/);
  assert.match(two, /For each, find out why/);
});
