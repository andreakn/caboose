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
