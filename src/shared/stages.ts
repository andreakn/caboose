// Release stages as text, for the settings: one "name = pattern" per line.
import type { ReleaseStage } from "./types.ts";

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

/**
 * How far a feature has shipped, per stage: of the repos with tag rules for
 * it, how many are tagged. Stages in the order the repos list them.
 */
export function deployProgress(repos: { name: string; stages?: string[]; release?: { stage: string; tags: string[] }[] }[]) {
  const names: string[] = [];
  for (const r of repos) for (const s of r.stages ?? []) if (!names.includes(s)) names.push(s);
  return names.map((stage) => {
    const counted = repos.filter((r) => r.stages?.includes(stage));
    const done = counted.filter((r) => r.release?.some((x) => x.stage === stage && x.tags.length > 0));
    return { stage, total: counted.length, done: done.length, repos: counted.map((r) => ({ name: r.name, tagged: done.includes(r) })) };
  });
}
