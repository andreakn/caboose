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
  /** Commits on this branch that its base does not have (what a PR would bring). */
  aheadBase?: number;
  /** Commits on the base ref the branch does not have. */
  behindBase: number;
};

export type GitHubStatus =
  | { available: false; reason: string; branch: BranchStatus }
  | { available: true; branch: BranchStatus; pr: PullRequest | null };

export type MergeMethod = "squash" | "merge" | "rebase";

/** The method to merge with: the one last used if the repo allows it, else the first the repo allows (squash when unknown). */
export function pickMergeMethod(preferred: MergeMethod | null, allowed: MergeMethod[] | undefined): MergeMethod {
  if (!allowed?.length) return preferred ?? "squash";
  return preferred && allowed.includes(preferred) ? preferred : allowed[0];
}

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
  /** The commit a merged PR became on its base (a merge or squash commit). */
  mergeCommit?: string;
  /** The merge methods the repo allows (squash, merge commit, rebase); unknown when absent. */
  mergeMethods?: MergeMethod[];
  /** Copilot's latest review, if it has reviewed. */
  copilot?: CopilotReview;
};

/**
 * Copilot's latest review of a PR. Copilot only comments (it never approves
 * in GitHub's sense), so its verdict is the heading of its review: 🟢
 * "Approval recommended", or something to look at. `current`: it reviewed
 * the PR's latest commit (else there are newer commits it has not seen).
 */
export type CopilotReview = { verdict: "approve" | "comments" | "changes" | "reviewed"; summary: string; at: string; current: boolean };

/** The verdict and its words from the heading of Copilot's review ("### 🟢 Approval recommended"). */
export function copilotVerdict(body: string): { verdict: CopilotReview["verdict"]; summary: string } {
  const heading = body.split("\n").find((l) => /^#{1,4}\s/.test(l.trim()))?.replace(/^#+\s*/, "").trim() ?? "";
  const summary = heading.replace(/^[\p{Extended_Pictographic}\uFE0F\s]+/u, "").trim() || "Reviewed";
  if (/🟢|✅/.test(heading) || /approv/i.test(summary)) return { verdict: "approve", summary };
  if (/🔴|❌/.test(heading) || /change|block/i.test(summary)) return { verdict: "changes", summary };
  if (/🟡|🟠|⚠/.test(heading) || /comment|issue|suggest/i.test(summary)) return { verdict: "comments", summary };
  return { verdict: "reviewed", summary };
}

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

/** One message for the feature's chat: a PR for each of these repos, the same way as for one. */
export function createPrsMessage(
  repos: { repo: string; branch: string; baseRef: string; jiraKey?: string }[],
  draft: boolean,
  instructions?: string,
): string {
  return [
    `Open a ${draft ? "draft " : ""}pull request for each of these repos of the feature (each worktree is the repo's folder; run git and gh there):`,
    ...repos.map((r) => `- ${r.repo}: branch ${r.branch}, base ${baseBranch(r.baseRef)}${r.jiraKey ? `, Jira ${r.jiraKey}` : ""}`),
    "For each:",
    "1. Commit the uncommitted changes that belong in the PR, in small logical commits with clear messages (leave out scratch files).",
    "2. Push with `git push -u origin <branch>`.",
    `3. Create it with \`gh pr create --base <base>${draft ? " --draft" : ""}\`, with a clear title and a description of what changed and why. Follow that repo's conventions (CLAUDE.md, PR templates, commit style).`,
    "Where a Jira key is given, the PR belongs to that issue (the branch name carries the key, which is what links it); mention it in the description.",
    "Where the PRs depend on each other, say so in their descriptions (and in which order they should be merged).",
    instructions?.trim() ? `How I want PRs written:\n${instructions.trim()}` : "",
    "Reply with each PR's URL.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Failing CI on one PR or several: what failed, and how to go about it. */
export function fixCiMessage(failing: { repo: string; pr: number; checks: { name: string; url?: string }[] }[]): string {
  const one = failing.length === 1;
  return [
    one
      ? `CI fails on PR #${failing[0].pr} of the ${failing[0].repo} repo (the ${failing[0].repo}/ folder):`
      : "CI fails on these PRs of the feature (each repo's worktree is its folder):",
    ...failing.flatMap((f) => [
      ...(one ? [] : [`${f.repo}, PR #${f.pr}:`]),
      ...f.checks.map((c) => `${one ? "" : "  "}- ${c.name}${c.url ? ` (${c.url})` : ""}`),
    ]),
    "",
    `${one ? "Find out why" : "For each, find out why"}: \`gh pr checks\`, then \`gh run view <run-id> --log-failed\` in that repo's folder.`,
    "If the change broke it: fix it, run the same thing locally where you can (tests, build, lint), then commit and push.",
    "If it has nothing to do with the change (a flaky test, the runner, an outage): say so, and re-run the failed jobs with `gh run rerun <run-id> --failed` instead of changing code.",
    "Tell me what it was and what you did.",
  ].join("\n");
}

/** A local merge (pull, or the base into the branch): the files that conflicted, if it was aborted. */
export type MergeOutcome = { conflicts: string[] };

export function mergeConflictsMessage(repo: string, from: string, files: string[]): string {
  return [
    `Merging ${from} into the ${repo} repo's branch (the ${repo}/ folder) conflicts in:`,
    ...files.map((f) => `- ${f}`),
    "",
    `Fetch, merge ${from} into this branch, resolve the conflicts carefully, run the tests, then commit (and push if the branch is pushed).`,
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

/**
 * Only each check's latest run: a check run again on the same commit (a PR
 * title fixed, a job re-run) leaves its earlier run in GitHub's list, and an
 * old failure there is not a failure any more. Runs of the same name are
 * told apart by when they started (else their order in the list).
 */
export function latestRuns<T>(runs: T[], nameOf: (r: T) => string, startedOf: (r: T) => string | undefined): T[] {
  const best = new Map<string, { run: T; at: string; i: number }>();
  runs.forEach((run, i) => {
    const name = nameOf(run);
    const at = startedOf(run) ?? "";
    const prev = best.get(name);
    if (!prev || at > prev.at || (at === prev.at && i > prev.i)) best.set(name, { run, at, i });
  });
  return [...best.values()].sort((a, b) => a.i - b.i).map((x) => x.run);
}
