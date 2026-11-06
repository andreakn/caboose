// A workspace's branch and PR status, and the GitHub actions Caboose runs
// itself, through the git and gh command lines (gh owns the GitHub login).
import type { BranchStatus, Check, CheckState, GitHubStatus, MergeMethod, PullRequest } from "../../shared/github.ts";
import { git, run } from "./run.ts";

export type Runner = (file: string, args: string[], cwd: string) => Promise<string>;

const PR_FIELDS = "number,url,title,state,isDraft,mergeable,reviewDecision,baseRefName,statusCheckRollup";

export class GitHub {
  private run: Runner;
  private ghChecked?: Promise<string | null>;

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

  async push(wsPath: string, branch: string): Promise<void> {
    await git(wsPath, "push", "-u", "origin", branch);
  }

  /** Merges on GitHub. The branch is kept: the worktree still has it checked out. */
  async merge(wsPath: string, pr: number, method: MergeMethod): Promise<void> {
    await this.run("gh", ["pr", "merge", String(pr), `--${method}`], wsPath);
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
