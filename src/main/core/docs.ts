// A feature's working documents: plain markdown files in the feature folder,
// read and written by the user (in Caboose) and by the agents (as files).
//   brief.md            what the feature is for: goal, scope, contracts, order
//   plan.md             a checklist ("- [ ] …"); progress is the share ticked
//   briefs/<repo>.md    what one repo has to do
//   log.md              append-only: notes, decisions and status reports
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FeatureDocs, LogEntry, PlanTask, RepoStatus } from "../../shared/types.ts";
import { REPO_STATUSES } from "../../shared/types.ts";

const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");

export const docPath = (folder: string, doc: "brief" | "plan" | "log") => join(folder, `${doc}.md`);
export const repoBriefPath = (folder: string, repo: string) => join(folder, "briefs", `${repo}.md`);

export function readDocs(folder: string, repos: string[]): FeatureDocs {
  const plan = read(docPath(folder, "plan"));
  const tasks = planTasks(plan);
  return {
    brief: read(docPath(folder, "brief")),
    plan,
    tasks,
    progress: { done: tasks.filter((t) => t.done).length, total: tasks.length },
    repoBriefs: Object.fromEntries(repos.map((r) => [r, read(repoBriefPath(folder, r))])),
    log: readLog(folder),
  };
}

export function writeDoc(folder: string, doc: "brief" | "plan", text: string): void {
  writeFileSync(docPath(folder, doc), text.endsWith("\n") || !text ? text : `${text}\n`);
}

export function writeRepoBrief(folder: string, repo: string, text: string): void {
  mkdirSync(join(folder, "briefs"), { recursive: true });
  writeFileSync(repoBriefPath(folder, repo), text.endsWith("\n") || !text ? text : `${text}\n`);
}

// ---- plan ----------------------------------------------------------------

const TASK_RE = /^(\s*)[-*] \[( |x|X)\] (.*)$/;

export function planTasks(markdown: string): PlanTask[] {
  const tasks: PlanTask[] = [];
  markdown.split("\n").forEach((line, i) => {
    const m = TASK_RE.exec(line);
    if (m) tasks.push({ line: i, done: m[2] !== " ", text: m[3], depth: Math.floor(m[1].length / 2) });
  });
  return tasks;
}

/** Ticks or unticks the task on a line (of the file as it is now). */
export function setTask(folder: string, line: number, done: boolean): void {
  const file = docPath(folder, "plan");
  const lines = read(file).split("\n");
  if (!TASK_RE.test(lines[line] ?? "")) throw new Error(`Line ${line + 1} of plan.md is not a task.`);
  lines[line] = lines[line].replace(/\[( |x|X)\]/, done ? "[x]" : "[ ]");
  writeFileSync(file, lines.join("\n"));
}

// ---- log -----------------------------------------------------------------
// Entries are markdown sections:  ### 2026-11-06 10:12:33 · <from>[ → <to>][ · status: <status>]

const HEADER_RE = /^### (\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?) · (.+?)(?: → (.+?))?(?: · status: ([a-z-]+))?\s*$/;

export function readLog(folder: string): LogEntry[] {
  const entries: LogEntry[] = [];
  let cur: LogEntry | null = null;
  for (const line of read(docPath(folder, "log")).split("\n")) {
    const m = HEADER_RE.exec(line);
    if (m) {
      cur = { at: m[1], from: m[2].trim(), ...(m[3] ? { to: m[3].trim() } : {}), ...(m[4] ? { status: m[4] as RepoStatus } : {}), text: "" };
      entries.push(cur);
    } else if (cur) cur.text += `${line}\n`;
  }
  for (const e of entries) e.text = e.text.trim();
  return entries;
}

export function appendLog(folder: string, e: { from: string; to?: string; status?: RepoStatus; text: string }, now = new Date()): LogEntry {
  if (e.status && !REPO_STATUSES.includes(e.status)) throw new Error(`Unknown status "${e.status}". Use one of: ${REPO_STATUSES.join(", ")}.`);
  const clean = (s: string) => s.replace(/[·→\n]/g, " ").replace(/\s+/g, " ").trim();
  const from = clean(e.from) || "you";
  const to = e.to ? clean(e.to) : undefined;
  const file = docPath(folder, "log");
  if (!existsSync(file)) writeFileSync(file, "# Log\n");
  const at = stamp(now);
  appendFileSync(file, `\n### ${at} · ${from}${to ? ` → ${to}` : ""}${e.status ? ` · status: ${e.status}` : ""}\n\n${e.text.trim()}\n`);
  return { at, from, ...(to ? { to } : {}), ...(e.status ? { status: e.status } : {}), text: e.text.trim() };
}

/** Each repo's latest reported status. */
export function reportedStatuses(log: LogEntry[]): Record<string, { status: RepoStatus; at: string; text: string }> {
  const out: Record<string, { status: RepoStatus; at: string; text: string }> = {};
  for (const e of log) if (e.status) out[e.from] = { status: e.status, at: e.at, text: e.text };
  return out;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
