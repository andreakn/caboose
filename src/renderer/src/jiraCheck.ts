// Before PRs are opened: their branches should have Jira issues (Jira automation follows
// the key in the branch name). When the feature has no task, or repos have no
// subtask, the user is asked whether to create them: a task (or an existing
// one linked) and a subtask per repo under it.
import { parseKeyLike } from "../../shared/jirakey.ts";
import type { Feature, FeatureJira, FeatureRepo, JiraLevel } from "../../shared/types.ts";
import { askChoice } from "./Dialog.tsx";
import { repoLabel } from "./labels.ts";

const api = window.caboose;

/** The feature's Jira as it is after asking (null: cancelled). Without Jira, or when it is off, as it was. */
export async function jiraBeforePrs(f: Feature, repos: FeatureRepo[], level: JiraLevel, connected: boolean): Promise<FeatureJira | null> {
  const jira = await api.featureJira(f.id);
  if (level === "off" || !connected || !repos.length) return jira;
  const without = repos.filter((r) => !jira.subtasks[r.name]);
  if (jira.task && !without.length) return jira;
  const names = without.map((r) => repoLabel(r.name)).join(", ");
  const skip = level === "required" ? [] : [{ id: "skip", label: "Open without Jira" }];

  if (!jira.task) {
    const c = await askChoice({
      title: "No Jira task for this feature",
      body: `The PR${repos.length === 1 ? "" : "s"} would have no Jira issue. Create a task for the feature, and a subtask under it for each repo (${f.repos.map((r) => repoLabel(r.name)).join(", ")})? Their keys go into the branches that are not pushed yet.`,
      input: { label: "Summary of the new task, or the key of an existing one", value: f.title ?? "", placeholder: "What the feature does, or ABC-123" },
      buttons: [{ id: "cancel", label: "Cancel" }, ...skip, { id: "create", label: "Create task and subtasks", primary: true }],
    });
    if (!c || c.id === "cancel") return null;
    if (c.id === "skip") return jira;
    const key = parseKeyLike(c.value);
    const r = key ? await api.setFeatureTask(f.id, key) : await api.createFeatureTask(f.id, c.value.trim());
    if (!r.ok) {
      alert(r.error);
      return null;
    }
    tellSkipped(r.value.skipped);
    return api.featureJira(f.id);
  }

  const c = await askChoice({
    title: `No Jira subtask for ${names}`,
    body: `Create ${without.length === 1 ? "a subtask" : "subtasks"} under ${jira.task} for ${names}? Their keys go into the branches that are not pushed yet.`,
    buttons: [{ id: "cancel", label: "Cancel" }, ...skip, { id: "create", label: without.length === 1 ? "Create the subtask" : "Create the subtasks", primary: true }],
  });
  if (!c || c.id === "cancel") return null;
  if (c.id === "skip") return jira;
  const r = await api.alignJira(f.id);
  if (!r.ok) {
    alert(r.error);
    return null;
  }
  tellSkipped(r.value.skipped);
  return api.featureJira(f.id);
}

/** Pushed branches keep their names (renaming would cut them off from their PRs): the key is only in the description then. */
function tellSkipped(skipped: string[]) {
  if (skipped.length)
    alert(`${skipped.join(", ")} ${skipped.length === 1 ? "was" : "were"} pushed already, so the branch name does not get the Jira key; the PR description will mention it.`);
}
