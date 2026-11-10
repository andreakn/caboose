// Cutting the next release tag, for repos whose release strategy is "tag":
// <prefix>_v<major>.<minor>, the minor bumped by one with its zero padding
// kept (orders_v1.005 -> orders_v1.006), a patch part dropped
// (orders_v1.234.1 -> orders_v1.235), and tags the repo lists as ignored
// never counted nor produced. The tag goes on the tip of origin's base branch
// (what "pull master, tag, push" would tag), so the checkout does not have to
// be on that branch, and only that one tag is pushed.
import type { ReleaseStrategy, RepoConfig, RepoEntry } from "../../shared/types.ts";
import { git } from "./run.ts";

const VERSION_RE = /^(.+)_v(\d+)\.(\d+)(?:\.(\d+))?$/;

/** The prefixes that have release tags (orders, stock…), most recently tagged first. */
export function tagPrefixes(tagsNewestFirst: string[]): string[] {
  const out: string[] = [];
  for (const t of tagsNewestFirst) {
    const m = VERSION_RE.exec(t);
    // Stage tags like orders_TEST_v1.2 belong to a stage, not a release prefix.
    if (m && !/_(TEST|PROD|STAGING|QA)$/i.test(m[1]) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Compares versions numerically: [major, minor, patch]. */
const parts = (t: string) => {
  const m = VERSION_RE.exec(t);
  return m ? [Number(m[2]), Number(m[3]), Number(m[4] ?? -1)] : [-1, -1, -1];
};

/** The latest release tag of a prefix and the one after it, or null when the prefix has none. */
export function nextTag(tags: string[], prefix: string, ignore: string[] = []): { latest: string; next: string } | null {
  const mine = tags.filter((t) => VERSION_RE.exec(t)?.[1] === prefix && !ignore.includes(t));
  if (!mine.length) return null;
  const latest = mine.sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  })[0];
  const m = VERSION_RE.exec(latest)!;
  const width = m[3].length;
  let minor = Number(m[3]);
  let next: string;
  do {
    minor++;
    next = `${prefix}_v${m[2]}.${String(minor).padStart(width, "0")}`;
  } while (ignore.includes(next) || tags.includes(next));
  return { latest, next };
}

/** A repo's release strategy: the machine's setting for it, else the repo's own (.caboose/config.json), else its line's default. */
export const strategyOf = (entry: RepoEntry | undefined, own: RepoConfig, lineDefault?: ReleaseStrategy): ReleaseStrategy | undefined =>
  entry?.releaseStrategy ?? own.releaseStrategy ?? lineDefault;

const baseBranch = (baseRef: string) => baseRef.replace(/^origin\//, "");

export type TagPlan = { base: string; commit: string; subject: string; prefixes: { prefix: string; latest: string; next: string }[] };

/** What tagging would do: origin's base after a fetch, and the next tag of each prefix. */
export async function tagPlan(source: string, baseRef: string, ignore: string[] = []): Promise<TagPlan> {
  const base = baseBranch(baseRef);
  await git(source, "fetch", "--quiet", "--tags", "origin", base);
  const commit = await git(source, "rev-parse", `origin/${base}`);
  const subject = await git(source, "log", "-1", "--format=%s", commit);
  const tags = (await git(source, "tag", "--list", "--sort=-creatordate")).split("\n").filter(Boolean);
  const prefixes = tagPrefixes(tags).flatMap((prefix) => {
    const n = nextTag(tags, prefix, ignore);
    return n ? [{ prefix, ...n }] : [];
  });
  return { base, commit, subject, prefixes };
}

/** Tags origin's base as the prefix's next version and pushes that tag; refuses if the tag appeared meanwhile. */
export async function tagNextRelease(source: string, baseRef: string, prefix: string, ignore: string[] = []): Promise<{ tag: string; previous: string; commit: string }> {
  const plan = await tagPlan(source, baseRef, ignore);
  const p = plan.prefixes.find((x) => x.prefix === prefix);
  if (!p) throw new Error(`No release tags with the prefix ${prefix}_v… to count up from. Create the first one by hand, e.g. git tag ${prefix}_v1.000`);
  await git(source, "tag", p.next, plan.commit);
  try {
    await git(source, "push", "origin", `refs/tags/${p.next}`);
  } catch (e) {
    await git(source, "tag", "-d", p.next).catch(() => "");
    throw e;
  }
  return { tag: p.next, previous: p.latest, commit: plan.commit };
}
