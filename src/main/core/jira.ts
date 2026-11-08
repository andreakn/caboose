// Jira Cloud over its REST API, with the user's email and API token, plus the
// jira.txt file in each feature folder that records the feature's links.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureJira, JiraIssue, JiraStatus } from "../../shared/types.ts";

export type JiraAuth = { site: string; email: string; token: string };
type Fetch = typeof fetch;

/** "ABC-123", or the key inside a Jira URL; null when there is none. */
export function parseKey(text: string): string | null {
  return /\b([A-Z][A-Z0-9_]+-\d+)\b/.exec(text.trim().toUpperCase())?.[1] ?? null;
}

export class Jira {
  private auth: JiraAuth;
  private fetch: Fetch;
  private site: string;

  constructor(auth: JiraAuth, fetchFn: Fetch = fetch) {
    this.auth = auth;
    this.fetch = fetchFn;
    this.site = auth.site.trim().replace(/\/+$/, "");
    const url = new URL(this.site);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error("The Jira site must be an https:// address.");
    }
  }

  /** Who the token belongs to (checks the connection). */
  async myself(): Promise<string> {
    const me = await this.call<{ displayName?: string; emailAddress?: string }>("GET", "/rest/api/3/myself");
    return me.displayName ?? me.emailAddress ?? "connected";
  }

  async issue(key: string): Promise<JiraIssue> {
    const i = await this.call<RawIssue>("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,issuetype,subtasks`);
    return this.toIssue(i);
  }

  /** Open issues assigned to the user, most recently updated first. */
  async myIssues(): Promise<JiraIssue[]> {
    const jql = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
    const r = await this.call<{ issues: RawIssue[] }>(
      "GET",
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=30&fields=summary,status,issuetype`,
    );
    return r.issues.map((i) => this.toIssue(i));
  }

  /** Status, assignee and summary for many issues in one search. */
  async statuses(keys: string[]): Promise<Record<string, JiraStatus>> {
    const valid = [...new Set(keys.filter((k) => /^[A-Z][A-Z0-9_]+-\d+$/.test(k)))].sort();
    if (!valid.length) return {};
    const jql = `key in (${valid.join(",")})`;
    const r = await this.call<{ issues: (RawIssue & { fields?: { assignee?: { displayName?: string }; status?: { name?: string; statusCategory?: { key?: string } } } })[] }>(
      "GET",
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary,status,assignee,issuetype`,
    );
    return Object.fromEntries(
      r.issues.map((i) => [
        i.key,
        {
          key: i.key,
          summary: i.fields?.summary ?? "",
          status: i.fields?.status?.name ?? "",
          category: (i.fields?.status?.statusCategory?.key ?? "new") as JiraStatus["category"],
          assignee: i.fields?.assignee?.displayName,
          url: this.url(i.key),
        },
      ]),
    );
  }

  async createTask(project: string, summary: string): Promise<string> {
    const types = await this.issueTypes(project);
    const type =
      types.find((t) => !t.subtask && /^task$/i.test(t.name)) ??
      types.find((t) => !t.subtask && /^story$/i.test(t.name)) ??
      types.find((t) => !t.subtask);
    if (!type) throw new Error(`Project ${project} has no issue type for tasks.`);
    const r = await this.call<{ key: string }>("POST", "/rest/api/3/issue", {
      fields: { project: { key: project }, summary, issuetype: { id: type.id } },
    });
    return r.key;
  }

  async createSubtask(parent: string, summary: string): Promise<string> {
    const project = parent.replace(/-\d+$/, "");
    const type = (await this.issueTypes(project)).find((t) => t.subtask);
    if (!type) throw new Error(`Project ${project} has no sub-task issue type.`);
    const r = await this.call<{ key: string }>("POST", "/rest/api/3/issue", {
      fields: { project: { key: project }, parent: { key: parent }, summary, issuetype: { id: type.id } },
    });
    return r.key;
  }

  url(key: string): string {
    return `${this.site}/browse/${key}`;
  }

  private async issueTypes(project: string): Promise<{ id: string; name: string; subtask: boolean }[]> {
    const r = await this.call<{ issueTypes?: RawType[]; values?: RawType[] }>(
      "GET",
      `/rest/api/3/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
    );
    return (r.issueTypes ?? r.values ?? []).map((t) => ({ id: t.id, name: t.name, subtask: Boolean(t.subtask) }));
  }

  private toIssue(i: RawIssue): JiraIssue {
    return {
      key: i.key,
      summary: i.fields?.summary ?? "",
      status: i.fields?.status?.name ?? "",
      type: i.fields?.issuetype?.name ?? "",
      url: this.url(i.key),
      subtasks: i.fields?.subtasks?.map((s) => ({ key: s.key, summary: s.fields?.summary ?? "" })),
    };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const basic = Buffer.from(`${this.auth.email}:${this.auth.token}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetch(`${this.site}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`Could not reach Jira at ${this.site}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
        detail = [...(j.errorMessages ?? []), ...Object.entries(j.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].join("; ") || detail;
      } catch {
        // not JSON
      }
      const why = res.status === 401 ? "the email or API token is wrong" : res.status === 404 ? "not found" : `HTTP ${res.status}`;
      throw new Error(`Jira: ${why}${detail ? ` (${detail})` : ""}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

type RawType = { id: string; name: string; subtask?: boolean };
type RawIssue = {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string };
    issuetype?: { name?: string };
    subtasks?: { key: string; fields?: { summary?: string } }[];
  };
};

/**
 * jira.txt in a feature folder: the feature's task on the first line, then
 * "<repo>: <subtask>" per repo. Written by Caboose, readable by people and
 * agents; edits by hand are picked up.
 */
export function readFeatureJira(folder: string): FeatureJira {
  const file = join(folder, "jira.txt");
  const out: FeatureJira = { subtasks: {} };
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([^:\s][^:]*?)\s*:\s*(.+)$/.exec(line);
    if (m && !/^https?$/i.test(m[1])) {
      const key = parseKey(m[2]);
      if (key) out.subtasks[m[1].trim()] = key;
    } else if (!out.task) {
      out.task = parseKey(line) ?? undefined;
    }
  }
  return out;
}

export function writeFeatureJira(folder: string, j: FeatureJira): void {
  const file = join(folder, "jira.txt");
  const lines = [
    ...(j.task ? [j.task] : []),
    ...Object.entries(j.subtasks).map(([repo, key]) => `${repo}: ${key}`),
  ];
  if (!lines.length) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
}
