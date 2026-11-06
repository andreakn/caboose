// Ending a feature: archive or delete. Both close its open PRs and delete
// its branches, here and on origin (never a main branch). Archiving then
// moves the feature folder (brief, plan, log, jira.txt) and its chat logs to
// <archive>/<yyyy-mm-dd_hh-mm>_<station>/; deleting deletes them. Either way
// Caboose forgets the feature.
import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
      const status = live ? await d.github.branchStatus(r.path, r.baseRef).catch(() => null) : null;
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
  const out: RetireOutcome = { closedPrs: [], deletedBranches: [], warnings: [] };

  for (const p of plan.repos) {
    if (!p.pr || (p.pr.state !== "OPEN" && p.pr.state !== "DRAFT")) continue;
    const r = f.repos.find((x) => x.name === p.repo)!;
    try {
      await d.github.closePr(existsSync(r.path) ? r.path : r.source, p.pr.number);
      out.closedPrs.push(p.pr.number);
    } catch (e) {
      throw new Error(`Could not close ${p.repo}'s PR #${p.pr.number}, so nothing was changed: ${(e as Error).message}`);
    }
  }

  await d.stop();

  for (const r of f.repos) {
    const warn = (what: string, e: unknown) => out.warnings.push(`${r.name}: ${what}: ${(e as Error).message.split("\n")[0]}`);
    if (existsSync(r.path)) {
      await d.archiveScript(r).catch((e) => warn("archive script", e));
      await removeWorktree(r.source, r.path).catch((e) => warn("removing the worktree", e));
      if (existsSync(r.path)) rmSync(r.path, { recursive: true, force: true });
    }
    if (keepReason(r)) continue;
    const local = await git(r.source, "rev-parse", "--verify", "--quiet", `refs/heads/${r.branch}`).then(() => true, () => false);
    if (local) {
      await git(r.source, "branch", "-D", r.branch).then(
        () => out.deletedBranches.push(`${r.name}: ${r.branch}`),
        (e) => warn(`deleting branch ${r.branch}`, e),
      );
    }
    const remote = await git(r.source, "ls-remote", "--exit-code", "--heads", "origin", r.branch).then((s) => s.length > 0, () => false);
    if (remote) {
      await git(r.source, "push", "origin", "--delete", r.branch).then(
        () => out.deletedBranches.push(`${r.name}: origin/${r.branch}`),
        (e) => warn(`deleting origin/${r.branch}`, e),
      );
    }
  }

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
    rmSync(f.folder, { recursive: true, force: true });
  }
  return out;
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
