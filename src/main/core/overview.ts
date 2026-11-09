// A feature at a glance: per repo what its agent reported, its local git
// state, its PR (one GraphQL call per feature) and its Jira subtask (one search
// per feature). GitHub and Jira answers are cached 60 s.
import type { Feature, FeatureJira, FeatureOverview, FeatureRepo, JiraStatus, ReleaseStage, ReleaseStrategy, Running, StageRelease } from "../../shared/types.ts";
import { stageEmoji } from "../../shared/stages.ts";
import { readDocs } from "./docs.ts";
import { releasesOf } from "./releases.ts";
import { resolveRunning } from "./running.ts";
import type { GitHub } from "./github.ts";
import type { Jira } from "./jira.ts";
import { type PrDetailsCache, slugOf } from "./prdetails.ts";

export type OverviewDeps = {
  github: GitHub;
  prs: PrDetailsCache;
  /** The Jira client of a line (its own, or the general one). */
  jira: (line?: string) => Jira | null;
  jiraOf: (featureId: string) => FeatureJira;
  /** Called when a worktree is on another branch than the one recorded (switched by an agent or by hand). */
  onBranch?: (featureId: string, repo: string, branch: string) => void;
  /** A repo's release tag stages (none: releases are not tracked). */
  stagesFor?: (repo: string) => ReleaseStage[];
  /** How a repo's releases are made (its config, else the repo's own). */
  strategyFor?: (r: FeatureRepo) => ReleaseStrategy | undefined;
  /** What a repo's .caboose/running.sh reports (null: it has none). Cached by the caller. */
  running?: (source: string, fresh: boolean) => Promise<Running | null>;
};

const jiraCache = new Map<string, { at: number; value: Promise<Record<string, JiraStatus>> }>();

function jiraStatuses(j: Jira, keys: string[], fresh: boolean, line = ""): Promise<Record<string, JiraStatus>> {
  // Per line too: two lines' Jira sites can have the same keys.
  const key = `${line}:${[...keys].sort().join(",")}`;
  const hit = jiraCache.get(key);
  if (hit && !fresh && Date.now() - hit.at < 60_000) return hit.value;
  const value = j.statuses(keys);
  jiraCache.set(key, { at: Date.now(), value });
  value.catch(() => jiraCache.delete(key));
  return value;
}

export async function featureOverview(f: Feature, d: OverviewDeps, fresh = false): Promise<FeatureOverview> {
  const docs = readDocs(f.folder, f.repos.map((r) => r.name));
  const reported: Record<string, (typeof docs.log)[number]> = {};
  for (const e of docs.log) if (e.status) reported[e.from] = e;
  const errors: string[] = [];

  const live = !f.archived;
  const [locals, slugs] = await Promise.all([
    Promise.all(f.repos.map((r) => (live ? d.github.branchStatus(r.path, r.baseRef).catch(() => null) : null))),
    Promise.all(f.repos.map((r) => slugOf(r.source))),
  ]);
  // PRs are looked up by the branch checked out now, not the one Caboose made the worktree with.
  const branches = f.repos.map((r, i) => locals[i]?.head ?? r.branch);
  f.repos.forEach((r, i) => branches[i] !== r.branch && d.onBranch?.(f.id, r.name, branches[i]));
  const queries = f.repos.flatMap((r, i) => (slugs[i] ? [{ repo: r.name, slug: slugs[i]!, branch: branches[i] }] : []));
  const prs = await d.prs.get(queries, fresh).catch((e: Error) => ({ prs: {}, error: e.message }) as { prs: Record<string, never>; error?: string });
  if (prs.error) errors.push(`GitHub: ${prs.error}`);

  const links = d.jiraOf(f.id);
  const keys = [links.task, ...Object.values(links.subtasks)].filter(Boolean) as string[];
  let statuses: Record<string, JiraStatus> = {};
  const j = keys.length ? d.jira(f.line) : null;
  if (j) statuses = await jiraStatuses(j, keys, fresh, f.line).catch((e: Error) => (errors.push(e.message), {}));
  const jiraFor = (key?: string) => (key ? (statuses[key] ?? { key }) : undefined);

  // Merged PRs: the lowest release tags carrying the merge commit (read from the main checkout's tags).
  const releases = await Promise.all(
    f.repos.map(async (r) => {
      const pr = prs.prs[r.name];
      const stages = d.stagesFor?.(r.name) ?? [];
      if (!pr || pr.state !== "MERGED" || !pr.mergeCommit || !stages.length) return undefined;
      return releasesOf(r.source, pr.mergeCommit, stages).catch(() => undefined);
    }),
  );

  // What runs where (repos with a running.sh), and whether it has the merged change.
  const running = await Promise.all(
    f.repos.map(async (r): Promise<Running | undefined> => {
      const report = await d.running?.(r.source, fresh).catch(() => null);
      if (!report) return undefined;
      const pr = prs.prs[r.name];
      const merge = pr?.state === "MERGED" ? pr.mergeCommit : undefined;
      const versions = await resolveRunning(r.source, report.versions, merge).catch(() => report.versions);
      return { versions, ...(report.error ? { error: report.error } : {}) };
    }),
  );

  // Repos where every merge is a release: merged means released and in test (the stages up to the first test-like one).
  const strategies = f.repos.map((r) => d.strategyFor?.(r));
  const merged = (i: number) => {
    const pr = prs.prs[f.repos[i].name];
    return pr?.state === "MERGED" ? pr : undefined;
  };
  const stageNames = (i: number) => {
    const names = (d.stagesFor?.(f.repos[i].name) ?? []).map((s) => s.name);
    return names.length ? names : strategies[i] === "merge" ? ["test"] : [];
  };
  const releaseOf = (i: number): StageRelease[] | undefined => {
    const tagged = releases[i];
    const pr = merged(i);
    if (strategies[i] !== "merge" || !pr) return tagged;
    const names = stageNames(i);
    const upTo = names.findIndex((n) => stageEmoji(n) === "🧪");
    const byMerge = new Set(names.slice(0, upTo >= 0 ? upTo + 1 : 1));
    return names.map((stage) => {
      const tags = tagged?.find((x) => x.stage === stage)?.tags ?? [];
      return { stage, tags: tags.length || !byMerge.has(stage) ? tags : [`merged #${pr.number}`] };
    });
  };

  return {
    id: f.id,
    progress: docs.progress,
    todosOpen: docs.todos.filter((t) => !t.done).length,
    task: jiraFor(links.task),
    repos: f.repos.map((r, i) => {
      const b = locals[i];
      return {
        name: r.name,
        branch: branches[i],
        reported: reported[r.name],
        local: b ? { uncommitted: b.uncommitted, ahead: b.ahead, aheadBase: b.aheadBase ?? 0, behindBase: b.behindBase, pushed: Boolean(b.upstream) } : undefined,
        pr: slugs[i] ? (r.name in prs.prs ? prs.prs[r.name] : undefined) : undefined,
        jira: jiraFor(links.subtasks[r.name]),
        ...(releaseOf(i) ? { release: releaseOf(i) } : {}),
        ...(stageNames(i).length ? { stages: stageNames(i) } : {}),
        ...(strategies[i] ? { strategy: strategies[i] } : {}),
        ...(running[i] ? { running: running[i] } : {}),
        ...(f.components?.[r.name]?.length ? { components: f.components[r.name] } : {}),
      };
    }),
    errors,
  };
}
