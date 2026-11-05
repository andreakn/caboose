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

/** "origin/main" → "main" */
export function baseBranch(baseRef: string): string {
  return baseRef.replace(/^origin\//, "");
}

export function createPrMessage(branch: string, baseRef: string, draft: boolean): string {
  return [
    `Open a ${draft ? "draft " : ""}pull request for this workspace:`,
    "1. Commit the uncommitted changes that belong in it, in small logical commits with clear messages (leave out scratch files).",
    `2. Push with \`git push -u origin ${branch}\`.`,
    `3. Create it with \`gh pr create --base ${baseBranch(baseRef)}${draft ? " --draft" : ""}\`, with a clear title and a description of what changed and why. Follow this repo's conventions (CLAUDE.md, PR templates, commit style).`,
    "Reply with the PR's URL.",
  ].join("\n");
}

export function fixChecksMessage(pr: PullRequest): string {
  const failed = pr.checks.filter((c) => c.state === "failure");
  return [
    `These checks fail on PR #${pr.number}:`,
    ...failed.map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`),
    "",
    "Find out why (`gh pr checks`, `gh run view <run-id> --log-failed`), fix it, run what you can locally, then commit and push.",
  ].join("\n");
}

export function resolveConflictsMessage(pr: PullRequest): string {
  return `PR #${pr.number} has merge conflicts with ${pr.baseRefName}. Fetch, merge origin/${pr.baseRefName} into this branch (rebase only if this repo clearly prefers it), resolve the conflicts carefully, run the tests, then commit and push.`;
}

export function checksSummary(checks: Check[]): { failed: number; pending: number; passed: number } {
  return {
    failed: checks.filter((c) => c.state === "failure").length,
    pending: checks.filter((c) => c.state === "pending").length,
    passed: checks.filter((c) => c.state === "success").length,
  };
}
