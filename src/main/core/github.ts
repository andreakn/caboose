// A workspace's branch and PR status, and the GitHub actions Caboose runs
// itself, through the git and gh command lines (gh owns the GitHub login).
import type { BranchStatus, Check, CheckState, GitHubStatus, MergeMethod, MergeOutcome, PullRequest } from "../../shared/github.ts";
import { git, run } from "./run.ts";

export type Runner = (file: string, args: string[], cwd: string) => Promise<string>;

const PR_FIELDS = "number,url,title,state,isDraft,mergeable,reviewDecision,baseRefName,statusCheckRollup";

export class GitHub {
  private run: Runner;
  private ghChecked?: Promise<string | null>;
  /** When each worktree last fetched origin (worktrees of one repo share the refs, so this is per path, approximately). */
  private fetchedAt = new Map<string, number>();

  constructor(runner: Runner = (f, a, cwd) => run(f, a, cwd)) {
    this.run = runner;
  }

  async status(wsPath: string, branch: string, baseRef: string): Promise<GitHubStatus> {
    const branchStatus = await this.branchStatus(wsPath, baseRef);
    const reason = await this.unavailable(wsPath);
    if (reason) return { available: false, reason, branch: branchStatus };
    return { available: true, branch: branchStatus, pr: await this.pr(wsPath, branchStatus.head ?? branch) };
  }

  async branchStatus(wsPath: string, baseRef: string): Promise<BranchStatus> {
    await this.fetchSometimes(wsPath);
    const out = await git(wsPath, "status", "--porcelain=v2", "--branch");
    const lines = out.split("\n");
    const upstream = lines.find((l) => l.startsWith("# branch.upstream "))?.slice(18);
    const head = lines.find((l) => l.startsWith("# branch.head "))?.slice(14);
    const ab = /# branch\.ab \+(\d+) -(\d+)/.exec(out);
    const uncommitted = lines.filter((l) => l && !l.startsWith("#")).length;
    const count = (range: string) =>
      git(wsPath, "rev-list", "--count", range)
        .then(Number)
        .catch(() => 0);
    return {
      ...(head && head !== "(detached)" ? { head } : {}),
      uncommitted,
      upstream,
      ahead: ab ? Number(ab[1]) : await count(`${baseRef}..HEAD`),
      behind: ab ? Number(ab[2]) : 0,
      behindBase: await count(`HEAD..${baseRef}`),
    };
  }

  /** The newest PR whose head is this branch, or null. */
  async pr(wsPath: string, branch: string): Promise<PullRequest | null> {
    const out = await this.run("gh", ["pr", "list", "--head", branch, "--state", "all", "--limit", "1", "--json", PR_FIELDS], wsPath);
    const list = JSON.parse(out) as RawPr[];
    return list[0] ? normalizePr(list[0]) : null;
  }

  /**
   * Fetches origin at most every 2 minutes, so "behind" counts are current.
   * Never prompts (no terminal to answer in) and gives up after 20 s; a
   * failed fetch just leaves the counts as they were.
   */
  private async fetchSometimes(wsPath: string, force = false): Promise<void> {
    if (!force && Date.now() - (this.fetchedAt.get(wsPath) ?? 0) < 120_000) return;
    this.fetchedAt.set(wsPath, Date.now());
    const fetch = run("git", ["fetch", "--quiet", "origin"], wsPath, { GIT_TERMINAL_PROMPT: "0" }).catch(() => "");
    await Promise.race([fetch, new Promise((r) => setTimeout(r, 20_000))]);
  }

  /** Pulls the branch's upstream: fast-forward when it can, else a merge. */
  async pull(wsPath: string): Promise<MergeOutcome> {
    await this.fetchSometimes(wsPath, true);
    try {
      await git(wsPath, "merge", "--ff-only", "@{u}");
      return { conflicts: [] };
    } catch {
      return this.mergeRef(wsPath, "@{u}");
    }
  }

  /** Merges the base (origin/main) into the branch. On conflicts nothing changes: the merge is aborted and the files are named. */
  async mergeBase(wsPath: string, baseRef: string): Promise<MergeOutcome> {
    await this.fetchSometimes(wsPath, true);
    return this.mergeRef(wsPath, baseRef);
  }

  private async mergeRef(wsPath: string, ref: string): Promise<MergeOutcome> {
    try {
      await git(wsPath, "merge", "--no-edit", ref);
      return { conflicts: [] };
    } catch (e) {
      const conflicts = (await git(wsPath, "diff", "--name-only", "--diff-filter=U").catch(() => "")).split("\n").filter(Boolean);
      if (!conflicts.length) throw e; // e.g. uncommitted changes in the way: git's own message says so
      await git(wsPath, "merge", "--abort");
      return { conflicts };
    }
  }

  async push(wsPath: string, branch: string): Promise<void> {
    await git(wsPath, "push", "-u", "origin", branch);
  }

  /** Merges on GitHub. The branch is kept: the worktree still has it checked out. */
  async merge(wsPath: string, pr: number, method: MergeMethod): Promise<void> {
    await this.run("gh", ["pr", "merge", String(pr), `--${method}`], wsPath);
    this.fetchedAt.delete(wsPath); // the base just moved
  }

  /** Closes a PR without merging (its branch is left to the caller). */
  async closePr(wsPath: string, pr: number): Promise<void> {
    await this.run("gh", ["pr", "close", String(pr)], wsPath);
  }

  async renameBranch(wsPath: string, from: string, to: string): Promise<void> {
    await git(wsPath, "check-ref-format", "--branch", to);
    await git(wsPath, "branch", "-m", from, to);
  }

  /** Why the GitHub part is off for this repo, or null when it is on. */
  private async unavailable(wsPath: string): Promise<string | null> {
    const url = await git(wsPath, "remote", "get-url", "origin").catch(() => "");
    if (!/github\.com[:/]/.test(url)) return "This repository's origin is not on GitHub.";
    this.ghChecked ??= this.run("gh", ["auth", "status"], wsPath).then(
      () => null,
      (e: Error) =>
        /ENOENT|not found|not recognized/i.test(e.message)
          ? "Install the GitHub CLI (gh) to see and create PRs."
          : "Log in to the GitHub CLI: run `gh auth login`.",
    );
    const reason = await this.ghChecked;
    if (reason) this.ghChecked = undefined; // check again next time
    return reason;
  }
}

type RawCheck = {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  workflowName?: string;
};
type RawPr = Omit<PullRequest, "checks"> & { statusCheckRollup?: RawCheck[] };

export function normalizePr(raw: RawPr): PullRequest {
  const { statusCheckRollup, ...pr } = raw;
  return { ...pr, checks: (statusCheckRollup ?? []).map(normalizeCheck) };
}

function normalizeCheck(c: RawCheck): Check {
  const name = c.name ? (c.workflowName ? `${c.workflowName} / ${c.name}` : c.name) : (c.context ?? "check");
  return { name, state: checkState(c), url: c.detailsUrl || c.targetUrl || undefined };
}

function checkState(c: RawCheck): CheckState {
  if (c.__typename === "StatusContext" || (c.state && !c.status)) {
    return c.state === "SUCCESS" ? "success" : c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : "failure";
  }
  if (c.status !== "COMPLETED") return "pending";
  switch (c.conclusion) {
    case "SUCCESS":
      return "success";
    case "SKIPPED":
    case "NEUTRAL":
      return "skipped";
    default:
      return "failure"; // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE, STALE
  }
}
