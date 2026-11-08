// Release stages as text, for the settings: one "name = pattern" per line.
import type { ReleaseStage, Running, RunningVersion } from "./types.ts";

/** "release = *_v*" lines → stages; blank lines and # comments are skipped. */
export function parseStages(text: string): ReleaseStage[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .flatMap((l) => {
      const m = l.match(/^([^=]+?)\s*=\s*(\S+)$/);
      return m ? [{ name: m[1], pattern: m[2] }] : [];
    });
}

export const formatStages = (stages: ReleaseStage[] | undefined) => (stages ?? []).map((s) => `${s.name} = ${s.pattern}`).join("\n");

/** An example to start from: a release tag, then tags marking deploys to test and prod. */
export const EXAMPLE_STAGES = "release = *_v*\ntest = *_TEST_v*\nprod = *_PROD_v*";

/** The running versions that matter: of the chosen components (all when none are chosen). */
export function relevantVersions(running: Running | undefined, components?: string[]): RunningVersion[] {
  const all = running?.versions ?? [];
  return components?.length ? all.filter((v) => !v.component || components.includes(v.component)) : all;
}

type ProgressRepo = { name: string; stages?: string[]; release?: { stage: string; tags: string[] }[]; running?: Running; components?: string[] };

/**
 * How far a feature has shipped, per stage (an environment): of the repos
 * tracked for it, how many have it. A repo whose running.sh reports the
 * environment has it when every component that matters runs a release with
 * the change; other repos have it once tagged. `pending`: tagged, but not
 * running yet (an approval, pods that do not start). Stages in the order the
 * repos list them, then environments only running.sh knows.
 */
export function deployProgress(repos: ProgressRepo[]) {
  const names: string[] = [];
  for (const r of repos) for (const s of r.stages ?? []) if (!names.includes(s)) names.push(s);
  for (const r of repos) for (const v of relevantVersions(r.running, r.components)) if (!names.includes(v.env)) names.push(v.env);
  return names.map((stage) => {
    const states = repos.flatMap((r) => {
      const live = relevantVersions(r.running, r.components).filter((v) => v.env === stage);
      if (!r.stages?.includes(stage) && !live.length) return [];
      const tagged = Boolean(r.release?.some((x) => x.stage === stage && x.tags.length > 0));
      const running = live.length ? live.every((v) => v.contains === true) : undefined;
      return [{ name: r.name, tagged, ...(running !== undefined ? { running } : {}), done: running ?? tagged }];
    });
    return {
      stage,
      total: states.length,
      done: states.filter((s) => s.done).length,
      pending: states.filter((s) => s.running === false && s.tagged).length,
      repos: states,
    };
  });
}
