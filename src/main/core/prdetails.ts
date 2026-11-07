// Everything about a feature's pull requests in one GitHub GraphQL call (via
// `gh api graphql`): per repo the newest PR on its branch, with review threads,
// reviews, checks, merge state and size. Cached 60 s; refresh bypasses it.
import type { PrDetails, PrThread } from "../../shared/github.ts";
import { git, run } from "./run.ts";

export type Runner = (file: string, args: string[], cwd?: string) => Promise<string>;
export type PrQuery = { repo: string; slug: string; branch: string };

const FAILED = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];
const PASSED = ["SUCCESS", "NEUTRAL", "SKIPPED"];

/** "owner/name" from a GitHub remote URL, or null. */
export function githubSlug(url: string): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const slugs = new Map<string, Promise<string | null>>();
/** The GitHub slug of a checkout's origin (cached per checkout). */
export function slugOf(checkout: string): Promise<string | null> {
  let p = slugs.get(checkout);
  if (!p) {
    p = git(checkout, "remote", "get-url", "origin").then(githubSlug, () => null);
    slugs.set(checkout, p);
  }
  return p;
}

const FIELDS = `number title url state isDraft reviewDecision mergeable mergeStateStatus additions deletions changedFiles
  headRefName baseRefName updatedAt author { login } mergeCommit { oid }
  reviewThreads(first: 100) { nodes { isResolved isOutdated path line comments(first: 1) { totalCount nodes { author { login } body url } } } }
  latestReviews(first: 30) { nodes { state author { login } } }
  reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name conclusion status detailsUrl checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state targetUrl } } } } } } }`;

export function buildQuery(qs: PrQuery[]): string {
  const parts = qs.map((q, i) => {
    const [owner, name] = q.slug.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      pullRequests(headRefName: ${JSON.stringify(q.branch)}, first: 1, states: [OPEN, MERGED, CLOSED], orderBy: { field: CREATED_AT, direction: DESC }) { nodes { ${FIELDS} } } }`;
  });
  return `query {\n${parts.join("\n")}\n}`;
}

type Raw = Record<string, any>;

export function shape(repo: string, pr: Raw): PrDetails {
  const threads: PrThread[] = (pr.reviewThreads?.nodes ?? [])
    .filter((t: Raw) => !t.isResolved)
    .map((t: Raw) => {
      const c = t.comments?.nodes?.[0] ?? {};
      return { path: t.path, line: t.line ?? null, outdated: Boolean(t.isOutdated), author: c.author?.login ?? "", body: String(c.body ?? "").slice(0, 500), url: c.url ?? pr.url, replies: Math.max(0, (t.comments?.totalCount ?? 1) - 1) };
    });
  const contexts: Raw[] = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checks = contexts.map((c) =>
    c.__typename === "CheckRun"
      ? { name: c.checkSuite?.workflowRun?.workflow?.name ? `${c.checkSuite.workflowRun.workflow.name} / ${c.name}` : c.name, url: c.detailsUrl ?? undefined, result: String(c.conclusion || c.status || "") }
      : { name: c.context, url: c.targetUrl ?? undefined, result: String(c.state ?? "") },
  );
  const failed = checks.filter((c) => FAILED.includes(c.result));
  const pending = checks.filter((c) => !FAILED.includes(c.result) && !PASSED.includes(c.result));
  const reviews = (pr.latestReviews?.nodes ?? []).map((r: Raw) => ({ state: r.state as string, author: r.author?.login as string }));
  return {
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.isDraft && pr.state === "OPEN" ? "DRAFT" : pr.state,
    reviewDecision: pr.reviewDecision ?? null,
    mergeable: pr.mergeable,
    mergeState: pr.mergeStateStatus,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
    head: pr.headRefName,
    base: pr.baseRefName,
    author: pr.author?.login ?? "",
    updatedAt: pr.updatedAt,
    threads,
    approvals: reviews.filter((r: { state: string }) => r.state === "APPROVED").map((r: { author: string }) => r.author),
    changesRequested: reviews.filter((r: { state: string }) => r.state === "CHANGES_REQUESTED").map((r: { author: string }) => r.author),
    requested: (pr.reviewRequests?.nodes ?? []).map((n: Raw) => n.requestedReviewer?.login).filter(Boolean),
    ...(pr.mergeCommit?.oid ? { mergeCommit: pr.mergeCommit.oid as string } : {}),
    checks: {
      state: !checks.length ? "none" : failed.length ? "failing" : pending.length ? "pending" : "passing",
      total: checks.length,
      passed: checks.length - failed.length - pending.length,
      failed: failed.map(({ name, url }) => ({ name, url })),
      pending: pending.length,
    },
  };
}

export class PrDetailsCache {
  private run: Runner;
  private cache = new Map<string, { at: number; value: Promise<{ prs: Record<string, PrDetails | null>; error?: string }> }>();

  constructor(runner: Runner = (f, a, cwd) => run(f, a, cwd)) {
    this.run = runner;
  }

  /** PR per repo name (null = no PR on that branch). One GraphQL call; 60 s cache. */
  get(qs: PrQuery[], fresh = false): Promise<{ prs: Record<string, PrDetails | null>; error?: string }> {
    const key = qs.map((q) => `${q.repo}=${q.slug}#${q.branch}`).join(",");
    const hit = this.cache.get(key);
    if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.value;
    const value = this.fetch(qs);
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  private async fetch(qs: PrQuery[]): Promise<{ prs: Record<string, PrDetails | null>; error?: string }> {
    if (!qs.length) return { prs: {} };
    let body: Raw;
    try {
      body = JSON.parse(await this.run("gh", ["api", "graphql", "-f", `query=${buildQuery(qs)}`]));
    } catch (e) {
      // gh exits non-zero when some repositories fail but still prints data
      const out = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      return { prs: {}, error: out.split("\n")[0].slice(0, 300) };
    }
    const prs: Record<string, PrDetails | null> = {};
    qs.forEach((q, i) => {
      const pr = body.data?.[`r${i}`]?.pullRequests?.nodes?.[0];
      prs[q.repo] = pr ? shape(q.repo, pr) : null;
    });
    return { prs, error: body.errors?.[0]?.message };
  }
}
