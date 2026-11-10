import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Comments } from "../src/main/core/comments.ts";
import { cabooseHandlers } from "../src/main/core/mcp.ts";
import { Store } from "../src/main/core/store.ts";
import { commentsMessage } from "../src/shared/diff.ts";
import type { Feature } from "../src/shared/types.ts";

const repo = mkdtempSync(join(tmpdir(), "caboose-mcp-"));
after(() => rmSync(repo, { recursive: true, force: true }));
const sh = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
sh("init", "-q", "-b", "main");
sh("-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "base");
writeFileSync(join(repo, "a.txt"), "hello\n");

const feature: Feature = {
  id: "w1", name: "finse", folder: repo, createdAt: "", archived: false, port: 41000,
  repos: [{ name: "app", source: repo, path: repo, branch: "main", baseRef: "main", setup: "none" }],
};
const store = new Store(join(repo, ".data", "state.json"));
const comments = new Comments(store);
const h = cabooseHandlers(() => feature, comments);

test("GetWorkspaceDiff lists and shows the workspace's changes", async () => {
  assert.match(await h.getWorkspaceDiff({ stat: true }), /app \(main vs main\):\n\s+untracked\s+\+1 -0\s+a\.txt/);
  assert.match(await h.getWorkspaceDiff({}), /\+hello/);
  assert.match(await h.getWorkspaceDiff({ path: "nope.txt" }), /No changes to nope\.txt/);
  assert.match(await h.getWorkspaceDiff({ repo: "web" }), /No repo "web"/);
});

test("Claude's comments land in the store; Claude reads only the user's", () => {
  h.diffComment({ comments: [{ file: "a.txt", line: 1, body: "Greeting could be friendlier" }] });
  assert.equal(comments.list("w1")[0].author, "claude");
  assert.equal(h.getDiffComments({}), "The user has left no comments.");
  comments.add({ featureId: "w1", repo: "app", file: "a.txt", line: 1, side: "new", lineText: "hello", body: "Say hi", author: "user" });
  assert.match(h.getDiffComments({}), /"body": "Say hi"/);
  assert.equal(comments.unsent("w1").length, 1);
});

test("unsent comments become one message for Claude", () => {
  const msg = commentsMessage(comments.unsent("w1"));
  assert.match(msg, /a review comment/);
  assert.match(msg, /\*\*app\/a\.txt:1\*\*\n```\nhello\n```\nSay hi/);
  comments.markSent(comments.unsent("w1").map((c) => c.id));
  assert.equal(comments.unsent("w1").length, 0);
});

test("SetComponents: the repo chat's repo (or the only one) by default; an empty list means all", () => {
  const calls: [string, string, string[] | null][] = [];
  const withSet = cabooseHandlers(() => feature, comments, undefined, { setComponents: (f, r, c) => (calls.push([f, r, c]), { ok: true, value: undefined }) });
  assert.match(withSet.setComponents({ components: ["orders", " ", "orders"] }), /app: this feature touches orders\./);
  assert.match(withSet.setComponents({ components: [] }), /all its components count again/);
  assert.match(withSet.setComponents({ repo: "nope", components: ["x"] }), /No repo "nope"/);
  assert.deepEqual(calls, [["w1", "app", ["orders"]], ["w1", "app", null]]);
  assert.match(h.setComponents({ components: ["x"] }), /cannot be set from here/);
});

test("LinkJira: links the repo chat's repo (or the only one); a bad key or repo is said, not linked", () => {
  const calls: [string, string, string | null][] = [];
  const withLink = cabooseHandlers(() => feature, comments, undefined, {
    linkJira: (f, r, k) => (calls.push([f, r, k]), /^[A-Z]+-\d+$/.test(k ?? "") ? { ok: true, value: undefined } : { ok: false, error: `"${k}" is not a Jira key.` }),
  });
  assert.match(withLink.linkJira({ key: "NWP-8303" }), /app is now linked to NWP-8303/);
  assert.match(withLink.linkJira({ key: "soon" }), /is not a Jira key/);
  assert.match(withLink.linkJira({ key: "NWP-1", repo: "nope" }), /No repo "nope"/);
  assert.deepEqual(calls, [
    ["w1", "app", "NWP-8303"],
    ["w1", "app", "soon"],
  ]);
  assert.match(h.linkJira({ key: "NWP-1" }), /cannot be set from here/);
});
