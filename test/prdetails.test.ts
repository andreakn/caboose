import { copilotPending } from "../src/shared/types.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildQuery, githubSlug, PrDetailsCache } from "../src/main/core/prdetails.ts";

test("slugs from GitHub remotes", () => {
  assert.equal(githubSlug("git@github.com:acme/shop-api.git"), "acme/shop-api");
  assert.equal(githubSlug("https://github.com/andreakn/caboose"), "andreakn/caboose");
  assert.equal(githubSlug("https://gitlab.com/x/y.git"), null);
});

test("one query for every repo; PRs shaped with threads, checks and reviews; cached", async () => {
  let calls = 0;
  const pr = {
    number: 714, title: "Batch sync", url: "https://github.com/o/web/pull/714", state: "OPEN", isDraft: false,
    reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", additions: 10, deletions: 2, changedFiles: 3,
    headRefName: "caboose/ABC-2-finse", headRefOid: "head1", baseRefName: "main", updatedAt: "2026-11-06T10:00:00Z", author: { login: "me" },
    reviewThreads: { nodes: [
      { isResolved: false, isOutdated: false, path: "src/a.ts", line: 4, comments: { totalCount: 3, nodes: [{ author: { login: "copilot" }, body: "Null check?", url: "u1" }] } },
      { isResolved: true, path: "src/b.ts", line: 1, comments: { totalCount: 1, nodes: [] } },
    ] },
    latestReviews: { nodes: [
      { state: "APPROVED", author: { login: "ann" } },
      { state: "CHANGES_REQUESTED", author: { login: "bob" } },
      { state: "COMMENTED", author: { login: "copilot-pull-request-reviewer" }, submittedAt: "2026-11-10T09:29:14Z", commit: { oid: "head1" },
        body: "<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\nNo active review issues remain.\n\n**No open issues** 🎉" },
    ] },
    reviewRequests: { nodes: [{ requestedReviewer: { login: "cid" } }, { requestedReviewer: {} }, { requestedReviewer: { login: "copilot-pull-request-reviewer" } }, { requestedReviewer: { name: "TECH - NWP Commerce Developers" } }] },
    commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", name: "build", conclusion: "SUCCESS", status: "COMPLETED", checkSuite: { workflowRun: { workflow: { name: "CI" } } } },
      { __typename: "CheckRun", name: "test", conclusion: "FAILURE", status: "COMPLETED", detailsUrl: "t" },
      { __typename: "StatusContext", context: "deploy", state: "PENDING" },
    ] } } } }] },
  };
  const cache = new PrDetailsCache(async (file, args) => {
    calls++;
    assert.equal(file, "gh");
    assert.match(args[3], /r0: repository\(owner: "o", name: "web"\)[\s\S]*headRefName: "caboose\/ABC-2-finse"[\s\S]*r1: repository/);
    return JSON.stringify({ data: { r0: { pullRequests: { nodes: [pr] } }, r1: { pullRequests: { nodes: [] } } } });
  });
  const qs = [
    { repo: "web", slug: "o/web", branch: "caboose/ABC-2-finse" },
    { repo: "api", slug: "o/api", branch: "caboose/ABC-3-finse" },
  ];
  const r = await cache.get(qs);
  assert.equal(r.prs.api, null);
  const p = r.prs.web!;
  assert.equal(p.state, "OPEN");
  assert.deepEqual(p.threads, [{ path: "src/a.ts", line: 4, outdated: false, author: "copilot", body: "Null check?", url: "u1", replies: 2 }]);
  assert.deepEqual([p.approvals, p.changesRequested, p.requested], [["ann"], ["bob"], ["cid", "copilot-pull-request-reviewer", "TECH - NWP Commerce Developers"]], "a team by its name");
  assert.deepEqual(p.copilot, { verdict: "approve", summary: "Approval recommended", at: "2026-11-10T09:29:14Z", current: true }, "Copilot's green light, on the latest commit");
  assert.equal(copilotPending(p), true, "Copilot (a bot) has been asked and not reviewed yet");
  assert.equal(copilotPending({ requested: ["cid"] }), false);
  assert.deepEqual(p.checks, { state: "failing", total: 3, passed: 1, failed: [{ name: "test", url: "t" }], pending: 1 });
  await cache.get(qs);
  assert.equal(calls, 1, "cached");
  await cache.get(qs, true);
  assert.equal(calls, 2, "fresh bypasses the cache");
  assert.match(buildQuery([{ repo: "x", slug: 'a"b/c', branch: "b" }]), /owner: "a\\"b"/);
});

test("Copilot's verdict from its review heading; asking again only helps when it has not seen the latest commit", async () => {
  const { copilotVerdict } = await import("../src/shared/github.ts");
  const { copilotWanted } = await import("../src/shared/types.ts");
  assert.deepEqual(copilotVerdict("<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\nNo issues"), { verdict: "approve", summary: "Approval recommended" });
  assert.deepEqual(copilotVerdict("### 🟡 Some issues to look at\n- a"), { verdict: "comments", summary: "Some issues to look at" });
  assert.deepEqual(copilotVerdict("### 🔴 Changes needed"), { verdict: "changes", summary: "Changes needed" });
  assert.deepEqual(copilotVerdict("## Pull request overview\nThis PR adds…"), { verdict: "reviewed", summary: "Pull request overview" });
  assert.equal(copilotWanted({ requested: [] }), true, "never reviewed");
  assert.equal(copilotWanted({ requested: [], copilot: { current: true } }), false, "already reviewed the latest commit");
  assert.equal(copilotWanted({ requested: [], copilot: { current: false } }), true, "new commits since");
  assert.equal(copilotWanted({ requested: ["copilot-pull-request-reviewer"] }), false, "pending");
});
