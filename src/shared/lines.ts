// Lines: groups of repos that belong together (a customer's, your own), so a
// feature only ever spans one. Optional and gradual: a line exists as long as
// some repo is on it, and a repo on no line serves every line. With no lines
// at all, Caboose behaves as if the concept did not exist.

/** The lines in use, from the repos on them. */
export function linesOf(repos: readonly { line?: string }[]): string[] {
  return [...new Set(repos.map((r) => r.line?.trim()).filter((l): l is string => Boolean(l)))].sort((a, b) => a.localeCompare(b));
}

/** Whether a repo can be in a feature on `line` (no line: any repo). */
export const servesLine = (repo: { line?: string }, line?: string) => !line || !repo.line || repo.line === line;

/** The repos a feature on `line` can have. */
export const reposFor = <R extends { line?: string }>(repos: R[], line?: string): R[] => repos.filter((r) => servesLine(r, line));
