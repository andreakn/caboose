// Archiving or deleting a feature: open PRs closed, branches deleted here and
// on origin, the folder and chat logs moved to the archive (or deleted).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GitHub } from "../src/main/core/github.ts";
import { archiveFolder, archiveStamp, retire, type RetireDeps, retirePlan, transcriptMarkdown } from "../src/main/core/retire.ts";
import type { Chat, ChatEvent } from "../src/shared/chat.ts";
import type { PullRequest } from "../src/shared/github.ts";
import type { Feature } from "../src/shared/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-retire-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

let n = 0;
/** A repo with an origin, and a feature with a worktree on `branch` (pushed), plus a brief. */
function setup(branch = "caboose/oslo") {
  const dir = join(tmp, `case${++n}`);
  const origin = join(dir, "origin.git");
  const source = join(dir, "web");
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "--bare", "-b", "main", origin);
  sh(dir, "clone", "-q", origin, source);
  sh(source, "config", "user.email", "t@e");
  sh(source, "config", "user.name", "T");
  sh(source, "commit", "-q", "--allow-empty", "-m", "base");
  sh(source, "push", "-q", "origin", "main");
  const folder = join(dir, "features", "oslo");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "brief.md"), "# The brief\n");
  const path = join(folder, "web");
  if (branch === "main") sh(source, "worktree", "add", "-q", "--detach", path, "origin/main");
  else {
    sh(source, "worktree", "add", "-q", "--no-track", "-b", branch, path, "origin/main");
    sh(path, "commit", "-q", "--allow-empty", "-m", "work");
    sh(path, "push", "-q", "-u", "origin", branch);
  }
  const f: Feature = {
    id: "f1",
    name: "oslo",
    title: "Fix the thing",
    folder,
    createdAt: "2026-11-06T10:00:00Z",
    archived: false,
    port: 41000,
    repos: [{ name: "web", source, path, branch, baseRef: "origin/main", setup: "none" }],
  };
  return { dir, origin, source, folder, path, f };
}

const pr = (state: PullRequest["state"], isDraft = false) => ({ number: 12, url: "https://github.com/o/web/pull/12", title: "The PR", state, isDraft }) as PullRequest;
const chat: Chat = { id: "c1", featureId: "f1", agent: "claude", title: "Fix the thing", model: "default", effort: "high", mode: "bypassPermissions", createdAt: "2026-11-06T10:00:00Z" } as Chat;
const events: ChatEvent[] = [
  { t: "user", id: "u1", text: "Please fix it", at: "2026-11-06T10:01:00Z" },
  { t: "tool", id: "t1", name: "Bash", input: { command: "npm test" } },
  { t: "tool_result", id: "t1", content: "ok", isError: false },
  { t: "text", id: "a1", text: "Fixed and tested." },
] as ChatEvent[];

function deps(over: Partial<RetireDeps> & { prState?: PullRequest["state"] | null; closeFails?: boolean } = {}) {
  const closed: number[] = [];
  let stopped = 0;
  const real = new GitHub();
  const d: RetireDeps = {
    github: {
      branchStatus: (p, b) => real.branchStatus(p, b),
      pr: async () => (over.prState === null ? null : pr(over.prState ?? "OPEN")),
      closePr: async (_p, number) => {
        if (over.closeFails) throw new Error("gh: not logged in");
        closed.push(number);
      },
    },
    archiveRoot: join(tmp, `archive${n}`),
    chats: [chat, { ...chat, id: "other", featureId: "f2" }],
    transcript: () => events,
    logs: [["setup-web.log", "installing…\n"]],
    archiveScript: async () => {},
    stop: async () => void stopped++,
    onGitHub: async () => true,
    now: new Date(2026, 10, 6, 15, 4),
    ...over,
  };
  return { d, closed, stopped: () => stopped };
}

const branches = (cwd: string) => sh(cwd, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
const remoteBranches = (origin: string) => sh(origin, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

test("archive folder names: yyyy-mm-dd_hh-mm_<station>, numbered when taken", () => {
  const d = new Date(2026, 0, 5, 9, 7);
  assert.equal(archiveStamp(d), "2026-01-05_09-07");
  const root = join(tmp, "names");
  const f = { name: "oslo" } as Feature;
  assert.equal(archiveFolder(root, f, d), join(root, "2026-01-05_09-07_oslo"));
  mkdirSync(join(root, "2026-01-05_09-07_oslo"), { recursive: true });
  assert.equal(archiveFolder(root, f, d), join(root, "2026-01-05_09-07_oslo-2"));
});

test("the plan shows the open PR, the branch, and work that would be lost", async () => {
  const { f, path } = setup();
  writeFileSync(join(path, "wip.txt"), "x");
  sh(path, "commit", "-q", "--allow-empty", "-m", "not pushed");
  const plan = await retirePlan(f, deps({ prState: "OPEN" }).d);
  assert.equal(plan.archiveTo, join(tmp, `archive${n}`, "2026-11-06_15-04_oslo"));
  assert.deepEqual(plan.repos[0], {
    repo: "web",
    branch: "caboose/oslo",
    pr: { number: 12, state: "OPEN", url: "https://github.com/o/web/pull/12", title: "The PR" },
    uncommitted: 1,
    unpushed: 1,
  });
});

test("archive: closes the open PR, deletes the branch here and on origin, moves folder and chat logs", async () => {
  const { f, source, origin, folder, path } = setup();
  const { d, closed, stopped } = deps({ prState: "OPEN" });
  const out = await retire(f, "archive", d);
  assert.deepEqual(closed, [12]);
  assert.equal(stopped(), 1);
  assert.deepEqual(out.closedPrs, [12]);
  assert.deepEqual(out.deletedBranches, ["web: caboose/oslo", "web: origin/caboose/oslo"]);
  assert.deepEqual(out.warnings, []);
  assert.ok(!existsSync(path) && !existsSync(folder), "worktree and folder are gone from the features folder");
  assert.deepEqual(branches(source), ["main"]);
  assert.deepEqual(remoteBranches(origin), ["main"]);
  assert.equal(sh(source, "worktree", "list").split("\n").length, 1, "the worktree is unregistered");

  const dest = out.archivedTo!;
  assert.equal(dest, join(tmp, `archive${n}`, "2026-11-06_15-04_oslo"));
  assert.equal(readFileSync(join(dest, "brief.md"), "utf8"), "# The brief\n");
  assert.deepEqual(readdirSync(join(dest, "chats")).sort(), ["01-fix-the-thing.jsonl", "01-fix-the-thing.md"], "only this feature's chats");
  const md = readFileSync(join(dest, "chats", "01-fix-the-thing.md"), "utf8");
  assert.match(md, /## You \(2026-11-06T10:01:00Z\)\n\nPlease fix it/);
  assert.match(md, /🔧 Bash \{"command":"npm test"\}/);
  assert.match(md, /Fixed and tested\./);
  assert.equal(readFileSync(join(dest, "chats", "01-fix-the-thing.jsonl"), "utf8").split("\n").filter(Boolean).length, 4);
  assert.equal(readFileSync(join(dest, "logs", "setup-web.log"), "utf8"), "installing…\n");
  const record = JSON.parse(readFileSync(join(dest, "feature.json"), "utf8"));
  assert.equal(record.feature.name, "oslo");
  assert.deepEqual(record.closedPrs, [12]);
});

test("delete: the same, but nothing is kept; merged PRs are left alone", async () => {
  const { f, source, origin, folder } = setup();
  const { d, closed } = deps({ prState: "MERGED" });
  const out = await retire(f, "delete", d);
  assert.deepEqual(closed, []);
  assert.equal(out.archivedTo, undefined);
  assert.ok(!existsSync(folder));
  assert.ok(!existsSync(join(tmp, `archive${n}`)), "nothing archived");
  assert.deepEqual(branches(source), ["main"]);
  assert.deepEqual(remoteBranches(origin), ["main"]);
});

test("a PR that cannot be closed stops everything before anything is changed", async () => {
  const { f, source, folder, path } = setup();
  const { d, stopped } = deps({ prState: "OPEN", closeFails: true });
  await assert.rejects(retire(f, "archive", d), /Could not close web's PR #12, so nothing was changed: gh: not logged in/);
  assert.equal(stopped(), 0);
  assert.ok(existsSync(path) && existsSync(folder));
  assert.ok(branches(source).includes("caboose/oslo"));
});

test("a main branch is never deleted, even if a worktree has it", async () => {
  const { f, source, origin } = setup("main");
  const plan = await retirePlan(f, deps({ prState: null }).d);
  assert.equal(plan.repos[0].keepBranch, "main is a main branch");
  const out = await retire(f, "delete", deps({ prState: null }).d);
  assert.deepEqual(out.deletedBranches, []);
  assert.ok(branches(source).includes("main"));
  assert.ok(remoteBranches(origin).includes("main"));
});

test("a transcript reads as markdown", () => {
  const md = transcriptMarkdown({ ...chat, repo: "web" }, events);
  assert.match(md, /^# Fix the thing\n\nclaude · web · started/);
});

test("repos whose origin is not on GitHub have no PR to look up", async () => {
  const { f } = setup();
  const plan = await retirePlan(f, { ...deps({ prState: "OPEN" }).d, onGitHub: undefined });
  assert.equal(plan.repos[0].pr, undefined);
  assert.equal(plan.repos[0].prError, undefined);
});
