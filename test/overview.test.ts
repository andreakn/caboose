import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { appendLog, writeDoc } from "../src/main/core/docs.ts";
import { featureOverview } from "../src/main/core/overview.ts";
import type { Feature } from "../src/shared/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-ov-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("the overview joins reports, git, PRs and Jira per repo", async () => {
  const src = join(tmp, "src-web");
  execFileSync("git", ["init", "-q", src]);
  execFileSync("git", ["remote", "add", "origin", "git@github.com:o/web.git"], { cwd: src });
  const plain = join(tmp, "src-api");
  execFileSync("git", ["init", "-q", plain]); // no GitHub remote
  const folder = join(tmp, "finse");
  mkdirSync(folder, { recursive: true });
  writeDoc(folder, "plan", "- [x] a\n- [ ] b\n");
  appendLog(folder, { from: "web", status: "in-review", text: "PR open" });
  const f: Feature = {
    id: "f", name: "finse", folder, createdAt: "", archived: false, port: 41000,
    repos: [
      { name: "web", source: src, path: src, branch: "caboose/NWP-2-finse", baseRef: "main", setup: "none" },
      { name: "api", source: plain, path: plain, branch: "caboose/NWP-3-finse", baseRef: "main", setup: "none" },
    ],
  };
  const asked: unknown[] = [];
  const ov = await featureOverview(f, {
    github: { branchStatus: async (p: string) => ({ uncommitted: p === src ? 1 : 0, ahead: 2, behind: 0, behindBase: 3, upstream: "origin/x" }) } as never,
    prs: { get: async (qs: unknown) => (asked.push(qs), { prs: { web: { number: 7 } } }) } as never,
    jira: () => ({ statuses: async (keys: string[]) => ({ "NWP-1": { key: "NWP-1", status: "In Progress", category: "indeterminate" }, ...(keys.includes("NWP-2") ? { "NWP-2": { key: "NWP-2", status: "Done", category: "done" } } : {}) }) }) as never,
    jiraOf: () => ({ task: "NWP-1", subtasks: { web: "NWP-2", api: "NWP-3" } }),
  });
  assert.deepEqual(asked, [[{ repo: "web", slug: "o/web", branch: "caboose/NWP-2-finse" }]], "only repos on GitHub are asked about");
  assert.deepEqual(ov.progress, { done: 1, total: 2 });
  assert.equal((ov.task as { status: string }).status, "In Progress");
  const [web, api] = ov.repos;
  assert.equal(web.reported?.status, "in-review");
  assert.deepEqual(web.local, { uncommitted: 1, ahead: 2, behindBase: 3, pushed: true });
  assert.equal(web.pr?.number, 7);
  assert.equal(api.pr, undefined, "not on GitHub: unknown, not 'no PR'");
  assert.equal((web.jira as { status: string }).status, "Done");
  assert.deepEqual(api.jira, { key: "NWP-3" }, "unknown to Jira: just the key");
});
