// A feature at a glance: per repo what its agent reported, its local git
// state, its PR (one GraphQL call per feature) and its Jira subtask (one search
// per feature). GitHub and Jira answers are cached 60 s.
import type { Feature, FeatureJira, FeatureOverview, JiraStatus } from "../../shared/types.ts";
import { readDocs } from "./docs.ts";
import type { GitHub } from "./github.ts";
import type { Jira } from "./jira.ts";
import { type PrDetailsCache, slugOf } from "./prdetails.ts";

export type OverviewDeps = {
  github: GitHub;
  prs: PrDetailsCache;
  jira: () => Jira | null;
  jiraOf: (featureId: string) => FeatureJira;
};

const jiraCache = new Map<string, { at: number; value: Promise<Record<string, JiraStatus>> }>();

function jiraStatuses(j: Jira, keys: string[], fresh: boolean): Promise<Record<string, JiraStatus>> {
  const key = [...keys].sort().join(",");
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
  const queries = f.repos.flatMap((r, i) => (slugs[i] ? [{ repo: r.name, slug: slugs[i]!, branch: r.branch }] : []));
  const prs = await d.prs.get(queries, fresh).catch((e: Error) => ({ prs: {}, error: e.message }) as { prs: Record<string, never>; error?: string });
  if (prs.error) errors.push(`GitHub: ${prs.error}`);

  const links = d.jiraOf(f.id);
  const keys = [links.task, ...Object.values(links.subtasks)].filter(Boolean) as string[];
  let statuses: Record<string, JiraStatus> = {};
  const j = keys.length ? d.jira() : null;
  if (j) statuses = await jiraStatuses(j, keys, fresh).catch((e: Error) => (errors.push(e.message), {}));
  const jiraFor = (key?: string) => (key ? (statuses[key] ?? { key }) : undefined);

  return {
    id: f.id,
    progress: docs.progress,
    task: jiraFor(links.task),
    repos: f.repos.map((r, i) => {
      const b = locals[i];
      return {
        name: r.name,
        branch: r.branch,
        reported: reported[r.name],
        local: b ? { uncommitted: b.uncommitted, ahead: b.ahead, behindBase: b.behindBase, pushed: Boolean(b.upstream) } : undefined,
        pr: slugs[i] ? (r.name in prs.prs ? prs.prs[r.name] : undefined) : undefined,
        jira: jiraFor(links.subtasks[r.name]),
      };
    }),
    errors,
  };
}
