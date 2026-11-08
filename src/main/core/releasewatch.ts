// Watching features ship: every few minutes, how far each feature's merged
// repos have got through the release stages (release, test, prod…), for live
// features and for ended ones alike (an archived feature still ships later).
// When a whole feature reaches a stage, that is announced once.
import type { FeatureOverview, ReleaseStage, Running, StationVisit, VisitRelease } from "../../shared/types.ts";
import { deployProgress, relevantVersions } from "../../shared/stages.ts";
import { releasesOf } from "./releases.ts";
import { resolveRunning } from "./running.ts";
import type { Store } from "./store.ts";

/** `running`: repos' running.sh confirmed it runs there (else the repos are only known to be tagged). */
export type ReleaseNews = { featureId: string; station: string; title?: string; stage: string; repos: number; running?: boolean };

export type ReleaseWatchDeps = {
  store: Store;
  overview: (featureId: string) => Promise<FeatureOverview>;
  stagesFor: (repo: string) => ReleaseStage[];
  announce: (news: ReleaseNews) => void;
  /** What a repo's .caboose/running.sh reports now (null: it has none). */
  running?: (source: string) => Promise<Running | null>;
};

/** A feature's progress per stage, from repos that each know their stages and releases. */
const complete = (repos: Parameters<typeof deployProgress>[0]) =>
  deployProgress(repos)
    .filter((p) => p.total > 0 && p.done === p.total)
    .map((p) => ({ stage: p.stage, running: p.repos.some((r) => r.running === true) }));

/** What an ended feature's releases look like as overview repos. */
export const visitRepos = (v: StationVisit) =>
  (v.releases ?? []).map((r) => ({ name: r.repo, stages: r.stages, release: r.release, running: r.running, components: r.components }));

/** The merged repos of a feature, with what is needed to keep checking their tags after it has ended. */
export function visitReleases(ov: FeatureOverview, sources: Record<string, string>, stagesFor: (repo: string) => ReleaseStage[]): VisitRelease[] {
  return ov.repos.flatMap((r) => {
    const stages = stagesFor(r.name);
    if (!r.pr || r.pr.state !== "MERGED" || !r.pr.mergeCommit || (!stages.length && !r.running)) return [];
    return [
      {
        repo: r.name,
        source: sources[r.name],
        mergeCommit: r.pr.mergeCommit,
        stages: stages.map((s) => s.name),
        release: r.release ?? [],
        ...(r.running ? { running: r.running } : {}),
        ...(r.components ? { components: r.components } : {}),
      },
    ];
  });
}

export class ReleaseWatch {
  private d: ReleaseWatchDeps;
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(d: ReleaseWatchDeps) {
    this.d = d;
  }

  /** First look after a short while (the app has just started), then every `everyMs`. */
  start(everyMs = 5 * 60_000, firstMs = 30_000): void {
    setTimeout(() => void this.check(), firstMs).unref?.();
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<ReleaseNews[]> {
    if (this.busy) return [];
    this.busy = true;
    try {
      const s = this.d.store.get();
      const found: { key: string; news: ReleaseNews }[] = [];
      // Live features: their overview already reads the tags.
      for (const f of s.features.filter((x) => !x.archived)) {
        const ov = await this.d.overview(f.id).catch(() => null);
        if (!ov) continue;
        for (const { stage, running } of complete(ov.repos)) {
          const repos = deployProgress(ov.repos).find((p) => p.stage === stage)?.total ?? 0;
          found.push({ key: `${f.id}:${stage}`, news: { featureId: f.id, station: f.name, ...(f.title ? { title: f.title } : {}), stage, repos, ...(running ? { running } : {}) } });
        }
      }
      // Ended features still on their way: read their tags again.
      const visits = await Promise.all(s.visits.map((v) => this.refresh(v)));
      if (visits.some((v, i) => v !== s.visits[i])) this.d.store.update((x) => ({ ...x, visits: x.visits.map((v) => visits.find((n) => n.featureId === v.featureId) ?? v) }));
      for (const v of visits) {
        for (const { stage, running } of complete(visitRepos(v))) {
          const repos = deployProgress(visitRepos(v)).find((p) => p.stage === stage)?.total ?? 0;
          found.push({ key: `${v.featureId}:${stage}`, news: { featureId: v.featureId, station: v.station, ...(v.title ? { title: v.title } : {}), stage, repos, ...(running ? { running } : {}) } });
        }
      }
      // Announce what is new; the first time ever, only remember (no flood for what shipped long ago).
      const seen = this.d.store.get().releaseNews;
      const fresh = found.filter((x) => !seen?.includes(x.key));
      if (fresh.length || !seen) this.d.store.update((x) => ({ ...x, releaseNews: [...(x.releaseNews ?? []), ...fresh.map((n) => n.key)] }));
      if (!seen) return [];
      for (const x of fresh) this.d.announce(x.news);
      return fresh.map((x) => x.news);
    } finally {
      this.busy = false;
    }
  }

  /** An ended feature with its tags (and what runs) read again, unless it has got everywhere already. */
  private async refresh(v: StationVisit): Promise<StationVisit> {
    const rs = v.releases ?? [];
    const tagsPending = (r: VisitRelease) => r.stages.some((stage) => !r.release.some((x) => x.stage === stage && x.tags.length));
    const runPending = (r: VisitRelease) => Boolean(r.running && (r.running.error || relevantVersions(r.running, r.components).some((x) => !x.contains)));
    if (!rs.some((r) => tagsPending(r) || runPending(r))) return v;
    const next = await Promise.all(
      rs.map(async (r) => {
        let out = r;
        if (tagsPending(r)) {
          const stages = this.d.stagesFor(r.repo).filter((s) => r.stages.includes(s.name));
          const release = await releasesOf(r.source, r.mergeCommit, stages).catch(() => r.release);
          if (JSON.stringify(release) !== JSON.stringify(r.release)) out = { ...out, release };
        }
        if (runPending(r) && this.d.running) {
          const report = await this.d.running(r.source).catch(() => null);
          if (report) {
            const versions = await resolveRunning(r.source, report.versions, r.mergeCommit).catch(() => report.versions);
            const running = { versions, ...(report.error ? { error: report.error } : {}) };
            if (JSON.stringify(running) !== JSON.stringify(r.running)) out = { ...out, running };
          }
        }
        return out;
      }),
    );
    return next.every((r, i) => r === rs[i]) ? v : { ...v, releases: next };
  }
}

