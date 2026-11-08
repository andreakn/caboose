// Ending a feature: archive or delete. Both close its open PRs and delete
// its branches, here and on origin (never a main branch). Archiving then
// moves the feature folder (brief, plan, log, jira.txt) and its chat logs to
// <archive>/<yyyy-mm-dd_hh-mm>_<station>/; deleting deletes them. Either way
// Caboose forgets the feature.
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { applyEvent, type Chat, type ChatEvent, type ChatItem, emptyView } from "../../shared/chat.ts";
import type { Feature, FeatureRepo, RetireMode, RetireOutcome, RetirePlan, RetireRepo } from "../../shared/types.ts";
import { removeWorktree } from "./git.ts";
import type { GitHub } from "./github.ts";
import { git } from "./run.ts";

export type RetireDeps = {
  github: Pick<GitHub, "pr" | "branchStatus" | "closePr">;
  archiveRoot: string;
  chats: Chat[];
  /** A chat's saved transcript. */
  transcript: (chatId: string) => ChatEvent[];
  /** Setup/archive script logs of the feature's repos: [name, text]. */
  logs: [string, string][];
  /** Runs a repo's archive script, if it has one (before its worktree goes). */
  archiveScript: (r: FeatureRepo) => Promise<void>;
  /** Stops the feature's chats, programs and terminals. */
  stop: () => Promise<void>;
  /** Whether the repo's origin is on GitHub (no PRs to look up otherwise). */
  onGitHub?: (cwd: string) => Promise<boolean>;
  now?: Date;
};

const originOnGitHub = (cwd: string) =>
  git(cwd, "remote", "get-url", "origin").then(
    (url) => /github\.com[:/]/.test(url),
    () => false,
  );

/** Branches that are never deleted, whatever a worktree has checked out. */
const MAIN_BRANCHES = ["main", "master", "develop", "development", "trunk"];

const pad = (n: number) => String(n).padStart(2, "0");
export const archiveStamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;

/** <archive>/<stamp>_<station>, with -2, -3… if that is taken. */
export function archiveFolder(root: string, f: Feature, now: Date): string {
  const base = join(root, `${archiveStamp(now)}_${f.name}`);
  let path = base;
  for (let i = 2; existsSync(path); i++) path = `${base}-${i}`;
  return path;
}

function keepReason(r: FeatureRepo): string | undefined {
  const base = r.baseRef.replace(/^origin\//, "");
  if (r.branch === base || MAIN_BRANCHES.includes(r.branch)) return `${r.branch} is a main branch`;
  return undefined;
}

/** What retiring the feature would do to each repo. */
export async function retirePlan(f: Feature, d: Pick<RetireDeps, "github" | "archiveRoot" | "now" | "onGitHub">): Promise<RetirePlan> {
  const repos = await Promise.all(
    f.repos.map(async (r): Promise<RetireRepo> => {
      const live = existsSync(r.path);
      const cwd = live ? r.path : r.source;
      // Local facts only: a fetch per repo would make the dialog (and deleting) wait on the network.
      const status = live ? await d.github.branchStatus(r.path, r.baseRef, false).catch(() => null) : null;
      let pr: RetireRepo["pr"];
      let prError: string | undefined;
      try {
        const p = (await (d.onGitHub ?? originOnGitHub)(cwd)) ? await d.github.pr(cwd, r.branch) : null;
        if (p) pr = { number: p.number, state: p.isDraft && p.state === "OPEN" ? "DRAFT" : p.state, url: p.url, title: p.title };
      } catch (e) {
        prError = (e as Error).message.split("\n")[0];
      }
      const keep = keepReason(r);
      return {
        repo: r.name,
        branch: r.branch,
        ...(pr ? { pr } : {}),
        ...(prError ? { prError } : {}),
        uncommitted: status?.uncommitted ?? 0,
        // Not pushed yet (or, never pushed: not on the base): gone with the branch.
        unpushed: status?.ahead ?? 0,
        ...(keep ? { keepBranch: keep } : {}),
      };
    }),
  );
  return { feature: f.name, ...(f.title ? { title: f.title } : {}), archiveTo: archiveFolder(d.archiveRoot, f, d.now ?? new Date()), repos };
}

/**
 * Closes the open PRs first (if one cannot be closed, nothing else happens),
 * then stops everything, removes the worktrees and deletes the branches, and
 * finally archives or deletes the folder. Later steps carry on past
 * failures and report them as warnings.
 */
export async function retire(f: Feature, mode: RetireMode, d: RetireDeps): Promise<RetireOutcome> {
  const now = d.now ?? new Date();
  const plan = await retirePlan(f, { ...d, now });
  const merged = plan.repos.length > 0 && plan.repos.every((r) => r.pr?.state === "MERGED");
  const out: RetireOutcome = { closedPrs: [], deletedBranches: [], warnings: [], merged };

  // Open PRs are closed first, all at once; if any cannot be, the rest of the feature is left as it is.
  const open = plan.repos.filter((p) => p.pr && (p.pr.state === "OPEN" || p.pr.state === "DRAFT"));
  const closing = await Promise.allSettled(
    open.map((p) => {
      const r = f.repos.find((x) => x.name === p.repo)!;
      return d.github.closePr(existsSync(r.path) ? r.path : r.source, p.pr!.number);
    }),
  );
  closing.forEach((c, i) => c.status === "fulfilled" && out.closedPrs.push(open[i].pr!.number));
  const failed = closing.flatMap((c, i) => (c.status === "rejected" ? [`${open[i].repo}'s PR #${open[i].pr!.number}: ${(c.reason as Error).message}`] : []));
  if (failed.length) {
    const closed = out.closedPrs.length ? ` (closed: ${out.closedPrs.map((n) => `#${n}`).join(", ")})` : "";
    throw new Error(`Could not close ${failed.join("; ")}. Nothing else was changed${closed}.`);
  }

  await d.stop();

  // Every repo at once: each only waits for its own archive script and network round-trip.
  const trash = trashDir(f);
  await Promise.all(
    f.repos.map(async (r) => {
      const warn = (what: string, e: unknown) => out.warnings.push(`${r.name}: ${what}: ${(e as Error).message.split("\n")[0]}`);
      if (existsSync(r.path)) {
        await d.archiveScript(r).catch((e) => warn("archive script", e));
        await discardWorktree(r, trash).catch((e) => warn("removing the worktree", e));
      }
      if (keepReason(r)) return;
      await git(r.source, "branch", "-D", r.branch).then(
        () => out.deletedBranches.push(`${r.name}: ${r.branch}`),
        (e) => /not found/.test((e as Error).message) || warn(`deleting branch ${r.branch}`, e),
      );
      // One round-trip: a branch that is not on origin (never pushed, or deleted on merge) is fine.
      await git(r.source, "push", "origin", "--delete", r.branch).then(
        () => out.deletedBranches.push(`${r.name}: origin/${r.branch}`),
        (e) => /remote ref does not exist|unable to delete|does not appear to be a git repository|No such remote/.test((e as Error).message) || warn(`deleting origin/${r.branch}`, e),
      );
    }),
  );

  if (mode === "archive") {
    const dest = plan.archiveTo;
    mkdirSync(join(dest, ".."), { recursive: true });
    if (existsSync(f.folder)) move(f.folder, dest);
    mkdirSync(dest, { recursive: true });
    const chats = d.chats.filter((c) => c.featureId === f.id);
    if (chats.length) mkdirSync(join(dest, "chats"), { recursive: true });
    chats.forEach((c, i) => {
      const events = d.transcript(c.id);
      const name = `${pad(i + 1)}-${slug(c.repo ? `${c.repo}-${c.title}` : c.title)}`;
      writeFileSync(join(dest, "chats", `${name}.md`), transcriptMarkdown(c, events));
      writeFileSync(join(dest, "chats", `${name}.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    });
    if (d.logs.length) {
      mkdirSync(join(dest, "logs"), { recursive: true });
      for (const [name, text] of d.logs) writeFileSync(join(dest, "logs", name), text);
    }
    const record = { feature: f, archivedAt: now.toISOString(), chats, closedPrs: out.closedPrs, deletedBranches: out.deletedBranches, plan };
    writeFileSync(join(dest, "feature.json"), `${JSON.stringify(record, null, 2)}\n`);
    out.archivedTo = dest;
  } else if (existsSync(f.folder)) {
    throwAway(f.folder, trash);
  }
  return out;
}

/** A trash folder beside the features (same disk, so moving into it is instant). */
export const trashDir = (f: Feature) => join(dirname(f.folder), ".caboose-trash");

/** Moves a folder into the trash at once and deletes it in the background. */
function throwAway(path: string, trash: string): void {
  mkdirSync(trash, { recursive: true });
  const gone = join(trash, `${basename(path)}-${randomUUID().slice(0, 8)}`);
  try {
    renameSync(path, gone);
  } catch {
    rmSync(path, { recursive: true, force: true }); // another disk: the slow way
    return;
  }
  void rm(gone, { recursive: true, force: true }).catch(() => {});
}

/**
 * A worktree gone in an instant: its folder (node_modules, bin, obj: often
 * tens of thousands of files) is moved to the trash, git forgets the worktree,
 * and the files are deleted in the background.
 */
async function discardWorktree(r: FeatureRepo, trash: string): Promise<void> {
  try {
    throwAway(r.path, trash);
  } catch {
    return removeWorktree(r.source, r.path);
  }
  await git(r.source, "worktree", "prune");
}

/** rename, or copy + delete across disks. */
function move(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9æøåäö]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "chat";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** A chat as readable markdown: what you wrote, what the agent answered, one line per tool call. */
export function transcriptMarkdown(c: Chat, events: ChatEvent[]): string {
  const view = events.reduce(applyEvent, emptyView());
  const lines = [`# ${c.title}`, "", `${c.agent ?? "claude"}${c.repo ? ` · ${c.repo}` : " · central"} · started ${c.createdAt}`, ""];
  const at = new Map(events.flatMap((e) => (e.t === "user" ? [[e.id, e.at]] : [])));
  for (const item of view.items as ChatItem[]) {
    switch (item.kind) {
      case "user":
        lines.push(`## You${at.get(item.id) ? ` (${at.get(item.id)})` : ""}`, "", item.text, "");
        break;
      case "text":
        lines.push(item.text, "");
        break;
      case "tool":
        lines.push(`- 🔧 ${item.name} ${clip(JSON.stringify(item.input) ?? "", 160)}${item.result?.isError ? " ✗" : ""}`, "");
        break;
      case "question":
        lines.push(`- ❓ ${item.questions.map((q) => q.question).join(" / ")} → ${item.answers ? Object.values(item.answers).join(", ") : "(not answered)"}`, "");
        break;
      case "proposal":
        lines.push(`- 📦 proposed repos: ${item.repos.map((r) => r.name).join(", ")}${item.answer ? ` → added ${item.answer.added.join(", ") || "none"}` : ""}`, "");
        break;
      case "error":
        lines.push(`> ⚠ ${item.text}`, "");
        break;
      case "result":
        if (!item.ok) lines.push(`> ✗ ${item.error ?? "failed"}`, "");
        break;
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
