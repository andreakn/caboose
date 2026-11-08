// Watching features ship: every few minutes, how far each feature's merged
// repos have got through the release stages (release, test, prod…), for live
// features and for ended ones alike (an archived feature still ships later).
// When a whole feature reaches a stage, that is announced once.
import type { FeatureOverview, ReleaseStage, StationVisit, VisitRelease } from "../../shared/types.ts";
import { deployProgress } from "../../shared/stages.ts";
import { releasesOf } from "./releases.ts";
import type { Store } from "./store.ts";

export type ReleaseNews = { featureId: string; station: string; title?: string; stage: string; repos: number };

export type ReleaseWatchDeps = {
  store: Store;
  overview: (featureId: string) => Promise<FeatureOverview>;
  stagesFor: (repo: string) => ReleaseStage[];
  announce: (news: ReleaseNews) => void;
};

/** A feature's progress per stage, from repos that each know their stages and releases. */
const complete = (repos: { name: string; stages?: string[]; release?: { stage: string; tags: string[] }[] }[]) =>
  deployProgress(repos)
    .filter((p) => p.total > 0 && p.done === p.total)
    .map((p) => p.stage);

/** What an ended feature's releases look like as overview repos. */
export const visitRepos = (v: StationVisit) => (v.releases ?? []).map((r) => ({ name: r.repo, stages: r.stages, release: r.release }));

/** The merged repos of a feature, with what is needed to keep checking their tags after it has ended. */
export function visitReleases(ov: FeatureOverview, sources: Record<string, string>, stagesFor: (repo: string) => ReleaseStage[]): VisitRelease[] {
  return ov.repos.flatMap((r) => {
    const stages = stagesFor(r.name);
    if (!r.pr || r.pr.state !== "MERGED" || !r.pr.mergeCommit || !stages.length) return [];
    return [{ repo: r.name, source: sources[r.name], mergeCommit: r.pr.mergeCommit, stages: stages.map((s) => s.name), release: r.release ?? [] }];
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
        for (const stage of complete(ov.repos)) {
          found.push({ key: `${f.id}:${stage}`, news: { featureId: f.id, station: f.name, ...(f.title ? { title: f.title } : {}), stage, repos: ov.repos.filter((r) => r.stages?.includes(stage)).length } });
        }
      }
      // Ended features still on their way: read their tags again.
      const visits = await Promise.all(s.visits.map((v) => this.refresh(v)));
      if (visits.some((v, i) => v !== s.visits[i])) this.d.store.update((x) => ({ ...x, visits: x.visits.map((v) => visits.find((n) => n.featureId === v.featureId) ?? v) }));
      for (const v of visits) {
        for (const stage of complete(visitRepos(v))) {
          found.push({ key: `${v.featureId}:${stage}`, news: { featureId: v.featureId, station: v.station, ...(v.title ? { title: v.title } : {}), stage, repos: (v.releases ?? []).length } });
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

  /** An ended feature with its tags read again, unless it has reached the end of every repo's stages. */
  private async refresh(v: StationVisit): Promise<StationVisit> {
    const rs = v.releases ?? [];
    const pending = rs.filter((r) => r.stages.some((stage) => !r.release.some((x) => x.stage === stage && x.tags.length)));
    if (!pending.length) return v;
    const next = await Promise.all(
      rs.map(async (r) => {
        if (!pending.includes(r)) return r;
        const stages = this.d.stagesFor(r.repo).filter((s) => r.stages.includes(s.name));
        const release = await releasesOf(r.source, r.mergeCommit, stages).catch(() => r.release);
        return JSON.stringify(release) === JSON.stringify(r.release) ? r : { ...r, release };
      }),
    );
    return next.every((r, i) => r === rs[i]) ? v : { ...v, releases: next };
  }
}

