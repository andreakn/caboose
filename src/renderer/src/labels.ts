// Repos' friendly names from the config (Configure → Repositories). The
// repo's name stays its id and folder name; this is only what is shown.
let labels = new Map<string, string>();

export function setRepoLabels(repos: { name: string; label?: string }[] | undefined): void {
  labels = new Map((repos ?? []).flatMap((r) => (r.label?.trim() ? [[r.name, r.label.trim()]] : [])));
}

/** What to call a repo on screen: its friendly name, else its name. */
export const repoLabel = (name: string): string => labels.get(name) ?? name;
