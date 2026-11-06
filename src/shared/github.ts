// GitHub state of a workspace, and the messages that hand PR work to Claude.

export type CheckState = "pending" | "success" | "failure" | "skipped";
export type Check = { name: string; state: CheckState; url?: string };

export type PullRequest = {
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";
  baseRefName: string;
  checks: Check[];
};

export type BranchStatus = {
  /** The branch checked out now (an agent or you may have switched it); absent when detached. */
  head?: string;
  /** Changed or untracked files not committed yet. */
  uncommitted: number;
  /** The upstream branch, once pushed. */
  upstream?: string;
  /** Commits not pushed yet (all of them if there is no upstream). */
  ahead: number;
  /** Commits on the upstream not pulled. */
  behind: number;
  /** Commits on the base ref the branch does not have. */
  behindBase: number;
};

export type GitHubStatus =
  | { available: false; reason: string; branch: BranchStatus }
  | { available: true; branch: BranchStatus; pr: PullRequest | null };

export type MergeMethod = "squash" | "merge" | "rebase";

/** An unresolved review thread on a PR. */
export type PrThread = { path: string; line: number | null; outdated: boolean; author: string; body: string; url: string; replies: number };

/** Everything the overview shows about one PR. */
export type PrDetails = {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "DRAFT" | "MERGED" | "CLOSED";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /** GitHub's merge state: CLEAN, BLOCKED, BEHIND, DIRTY (conflicts), UNSTABLE, DRAFT… */
  mergeState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  head: string;
  base: string;
  author: string;
  updatedAt: string;
  threads: PrThread[];
  approvals: string[];
  changesRequested: string[];
  requested: string[];
  checks: { state: "none" | "passing" | "pending" | "failing"; total: number; passed: number; failed: { name: string; url?: string }[]; pending: number };
};

/** "origin/main" → "main" */
export function baseBranch(baseRef: string): string {
  return baseRef.replace(/^origin\//, "");
}

export function createPrMessage(
  repo: string,
  branch: string,
  baseRef: string,
  draft: boolean,
  jiraKey?: string,
  instructions?: string,
): string {
  return [
    `Open a ${draft ? "draft " : ""}pull request for the ${repo} repo of this feature (its worktree is the ${repo}/ folder; run git and gh there):`,
    "1. Commit the uncommitted changes in it that belong in the PR, in small logical commits with clear messages (leave out scratch files).",
    `2. Push with \`git push -u origin ${branch}\`.`,
    `3. Create it with \`gh pr create --base ${baseBranch(baseRef)}${draft ? " --draft" : ""}\`, with a clear title and a description of what changed and why. Follow the repo's conventions (CLAUDE.md, PR templates, commit style).`,
    jiraKey
      ? `The PR belongs to Jira issue ${jiraKey} (the branch name carries the key, which is what links it); mention ${jiraKey} in the description.`
      : "",
    instructions?.trim() ? `How I want PRs written:\n${instructions.trim()}` : "",
    "Reply with the PR's URL.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function fixChecksMessage(repo: string, pr: PullRequest): string {
  const failed = pr.checks.filter((c) => c.state === "failure");
  return [
    `These checks fail on PR #${pr.number} of the ${repo} repo (the ${repo}/ folder):`,
    ...failed.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`),
    "",
    "Find out why (`gh pr checks`, `gh run view <run-id> --log-failed`), fix it, run what you can locally, then commit and push.",
  ].join("\n");
}

export function resolveConflictsMessage(repo: string, pr: PullRequest): string {
  return `PR #${pr.number} of the ${repo} repo (the ${repo}/ folder) has merge conflicts with ${pr.baseRefName}. Fetch, merge origin/${pr.baseRefName} into this branch (rebase only if this repo clearly prefers it), resolve the conflicts carefully, run the tests, then commit and push.`;
}

export function checksSummary(checks: Check[]): { failed: number; pending: number; passed: number } {
  return {
    failed: checks.filter((c) => c.state === "failure").length,
    pending: checks.filter((c) => c.state === "pending").length,
    passed: checks.filter((c) => c.state === "success").length,
  };
}
