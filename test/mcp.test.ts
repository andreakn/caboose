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
import type { Workspace } from "../src/shared/types.ts";

const repo = mkdtempSync(join(tmpdir(), "caboose-mcp-"));
after(() => rmSync(repo, { recursive: true, force: true }));
const sh = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
sh("init", "-q", "-b", "main");
sh("-c", "user.email=t@e", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "base");
writeFileSync(join(repo, "a.txt"), "hello\n");

const ws: Workspace = {
  id: "w1", repoId: "r", name: "finse", branch: "main", path: repo, baseRef: "main",
  createdAt: "", archived: false, setup: "none",
};
const store = new Store(join(repo, ".data", "state.json"));
const comments = new Comments(store);
const h = cabooseHandlers(() => ws, comments);

test("GetWorkspaceDiff lists and shows the workspace's changes", async () => {
  assert.match(await h.getWorkspaceDiff({ stat: true }), /untracked\s+\+1 -0\s+a\.txt/);
  assert.match(await h.getWorkspaceDiff({}), /\+hello/);
  assert.match(await h.getWorkspaceDiff({ path: "nope.txt" }), /No changes to nope\.txt/);
});

test("Claude's comments land in the store; Claude reads only the user's", () => {
  h.diffComment({ comments: [{ file: "a.txt", line: 1, body: "Greeting could be friendlier" }] });
  assert.equal(comments.list("w1")[0].author, "claude");
  assert.equal(h.getDiffComments({}), "The user has left no comments.");
  comments.add({ workspaceId: "w1", file: "a.txt", line: 1, side: "new", lineText: "hello", body: "Say hi", author: "user" });
  assert.match(h.getDiffComments({}), /"body": "Say hi"/);
  assert.equal(comments.unsent("w1").length, 1);
});

test("unsent comments become one message for Claude", () => {
  const msg = commentsMessage(comments.unsent("w1"));
  assert.match(msg, /a review comment/);
  assert.match(msg, /\*\*a\.txt:1\*\*\n```\nhello\n```\nSay hi/);
  comments.markSent(comments.unsent("w1").map((c) => c.id));
  assert.equal(comments.unsent("w1").length, 0);
});
