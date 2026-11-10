// Platforms: a feature delivered in waves. The station (folder, chats, log,
// plan, to-dos, Jira task) stays; each platform has its own goal, repos and
// branches. The next platform starts once the current one's work is merged
// (or closed): its repos get new branches from their base in the same
// worktrees, so their chats carry on where they were. The platform that
// ended is kept with its PRs, and its merged repos' releases are followed
// to prod like an ended feature's, unless it is marked superseded.
import type { Feature, FeatureJira, FeatureOverview, PastPlatform, ReleaseStage } from "../../shared/types.ts";
import { visitReleases } from "./releasewatch.ts";

/** The platform a feature is on: its own record, else platform 1 since the feature began. */
export const currentPlatform = (f: Feature) => f.platform ?? { n: 1, startedAt: f.createdAt };

/** `<prefix>/<KEY>-<station>`, with `-p<n>` from platform 2 on. */
export const platformBranch = (prefix: string, station: string, key: string | undefined, n: number) =>
  `${prefix}/${key ? `${key}-` : ""}${station}${n > 1 ? `-p${n}` : ""}`;

/**
 * What keeps the current platform from ending: a PR still open, work on a
 * branch that never got a PR, or changes not committed. Merged and closed PRs
 * are done with (a closed one is dropped, on purpose).
 */
export function platformBlockers(f: Feature, ov: FeatureOverview): string[] {
  return f.repos.flatMap((r) => {
    const o = ov.repos.find((x) => x.name === r.name);
    const pr = o?.pr;
    const out: string[] = [];
    if (o?.local?.uncommitted) out.push(`${r.name} has ${o.local.uncommitted} uncommitted change(s)`);
    if (pr && (pr.state === "OPEN" || pr.state === "DRAFT")) out.push(`${r.name}'s PR #${pr.number} is still open: merge or close it`);
    else if (!pr && (o?.local?.aheadBase ?? 0) > 0) out.push(`${r.name} has ${o!.local!.aheadBase} commit(s) on ${r.branch} that were never merged (no PR)`);
    return out;
  });
}

/** The platform that ends now, as it will be kept: its repos' branches, PRs and Jira keys, and its merged repos' releases. */
export function endedPlatform(f: Feature, ov: FeatureOverview, jira: FeatureJira, stagesFor: (repo: string) => ReleaseStage[], now = new Date()): PastPlatform {
  const cur = currentPlatform(f);
  const sources = Object.fromEntries(f.repos.map((r) => [r.name, r.source]));
  const releases = visitReleases(ov, sources, stagesFor);
  return {
    ...cur,
    endedAt: now.toISOString(),
    repos: f.repos.map((r) => {
      const pr = ov.repos.find((x) => x.name === r.name)?.pr;
      const key = jira.subtasks[r.name];
      return { name: r.name, branch: r.branch, ...(pr ? { pr: { number: pr.number, url: pr.url, state: pr.state } } : {}), ...(key ? { jira: key } : {}) };
    }),
    ...(releases.length ? { releases } : {}),
  };
}

/** The platforms whose releases still count: earlier ones not superseded, with merged repos. */
export const countedPlatforms = (f: Feature) => (f.platforms ?? []).filter((p) => !p.superseded && p.releases?.length);

/** Where the feature is in its platforms (waves), for the agents; "" while it is on its first and only one. */
export function platformText(f: Feature): string {
  const cur = currentPlatform(f);
  const past = f.platforms ?? [];
  if (cur.n === 1 && !past.length) return "";
  const earlier = past.map((p) => {
    const prs = p.repos.map((r) => `${r.name}${r.pr ? ` #${r.pr.number} ${r.pr.state.toLowerCase()}` : ""}`).join(", ");
    return `platform ${p.n}${p.goal ? ` (${p.goal})` : ""}${p.superseded ? ", superseded" : ""}: ${prs || "no repos"}`;
  });
  return [
    `This feature is delivered in platforms (waves), one after another; each has its own goal, repos and branches, and the branches of an earlier one are merged (or closed).`,
    `It is on platform ${cur.n}${cur.goal ? `, whose goal is: ${cur.goal}` : ""}. Do only this platform's part; plan.md has a section per platform.`,
    earlier.length ? `Earlier: ${earlier.join("; ")}. What they did is merged in the base branch; the log and the chats above say what was decided.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
