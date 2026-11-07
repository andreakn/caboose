// Which release carries a merged change: the lowest version tag, per stage,
// that contains the PR's merge commit. Stages are named tag patterns from the
// config, e.g. release = *_v*, test = *_TEST_v*, prod = *_PROD_v* (a tag
// matching several patterns counts for the last one, so `*_v*` does not also
// claim cda_TEST_v1.436). Repos with several services tag them with
// different prefixes (cdsws_v1.335, cbsws_v1.004): each prefix is reported.
import type { ReleaseStage, StageRelease } from "../../shared/types.ts";
import { git } from "./run.ts";

/** A glob (* and ?) as a whole-string regex. */
export function globRegex(glob: string): RegExp {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${body}$`);
}

/** The stage a tag belongs to: the last whose pattern matches. */
export function stageOf(tag: string, stages: ReleaseStage[]): string | undefined {
  for (let i = stages.length - 1; i >= 0; i--) if (globRegex(stages[i].pattern).test(tag)) return stages[i].name;
  return undefined;
}

/** "cda_v1.437" → "cda_", "v2.1.0" → "": the part before the version. */
export const prefixOf = (tag: string) => tag.replace(/v?\d+(?:[._-]\d+)*$/i, "");

/** From tags already sorted lowest version first: per stage (in stage order), the first tag of each prefix. */
export function lowestPerStage(tags: string[], stages: ReleaseStage[]): StageRelease[] {
  const found = new Map<string, Map<string, string>>(stages.map((s) => [s.name, new Map()]));
  for (const t of tags) {
    const stage = stageOf(t, stages);
    if (!stage) continue;
    const byPrefix = found.get(stage)!;
    if (!byPrefix.has(prefixOf(t))) byPrefix.set(prefixOf(t), t);
  }
  return stages.map((s) => ({ stage: s.name, tags: [...found.get(s.name)!.values()] }));
}

/** The releases carrying `commit` in the repo at `root` (its main checkout or a worktree). */
export async function releasesOf(root: string, commit: string, stages: ReleaseStage[]): Promise<StageRelease[]> {
  if (!stages.length) return [];
  const list = () => git(root, "tag", "--contains", commit, "--sort=v:refname");
  let out: string;
  try {
    out = await list();
  } catch {
    // The merge commit may not be fetched yet.
    await git(root, "fetch", "--quiet", "--tags", "origin").catch(() => "");
    out = await list().catch(() => "");
  }
  return lowestPerStage(out.split("\n").filter(Boolean), stages);
}
