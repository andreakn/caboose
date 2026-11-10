// Working on a feature across repos: the central chat (in the feature folder)
// can break out a chat per repo (in that repo's worktree), message it, and see
// how everything stands; every chat reports status and notes to log.md; the
// user's notes go to the chats they are for.
import type { Agent, Chat } from "../../shared/chat.ts";
import type { Feature, FeatureJira, FeatureRepo, RepoEntry, RepoStatus, Result } from "../../shared/types.ts";
import type { Chats } from "./chats.ts";
import { appendLog, readDocs, reportedStatuses } from "./docs.ts";
import type { Store } from "./store.ts";
import { platformText } from "./platforms.ts";

/** Live facts about a repo's worktree (git and PR), for the status overview. */
export type RepoFacts = {
  uncommitted: number;
  ahead: number;
  pushed: boolean;
  pr?: { number: number; state: string; checks: string; url: string } | null;
};

export type CoordinatorDeps = {
  store: Store;
  chats: Chats;
  jiraOf: (featureId: string) => FeatureJira;
  facts?: (repo: FeatureRepo) => Promise<RepoFacts | null>;
  /** The configured repos a feature can add (those on its line, and those on none). */
  repos?: (featureId: string) => RepoEntry[];
  addRepo?: (featureId: string, repo: string) => Promise<Result<void>>;
  setTitle?: (featureId: string, title: string) => Result<void>;
};

/** The names the agents know Caboose's tools by. */
export const TOOL_NAMES = {
  claude: { status: "mcp__caboose__ReportStatus", log: "mcp__caboose__Log", ask: "AskUserQuestion" },
  copilot: { status: "caboose_report_status", log: "caboose_log", ask: "ask_user" },
};

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (error: string): Result<never> => ({ ok: false, error });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class Coordinator {
  private d: CoordinatorDeps;

  constructor(deps: CoordinatorDeps) {
    this.d = deps;
  }

  private feature(id: string): Feature | undefined {
    return this.d.store.get().features.find((f) => f.id === id);
  }

  log(featureId: string, e: { from: string; to?: string; status?: RepoStatus; text: string }): Result<void> {
    const f = this.feature(featureId);
    if (!f) return fail("Unknown feature.");
    try {
      appendLog(f.folder, e);
      return ok(undefined);
    } catch (err) {
      return fail((err as Error).message);
    }
  }

  /**
   * Breaks out a chat for one repo, in its worktree, starting with `message`
   * plus how to work in Caboose. If the repo has a chat already, the message
   * goes there instead.
   */
  startRepoChat(featureId: string, repo: string, message: string, opts: { agent?: Agent; from?: string } = {}): Result<Chat> {
    const f = this.feature(featureId);
    if (!f || f.archived) return fail("Unknown or archived feature.");
    const r = f.repos.find((x) => x.name === repo);
    if (!r) return fail(`No repo "${repo}" in this feature. Its repos: ${f.repos.map((x) => x.name).join(", ")}.`);
    const existing = this.d.chats.latest(featureId, repo);
    if (existing) {
      const sent = this.d.chats.send(existing.id, `Message from ${opts.from ?? "the coordinator"}:\n${message}`);
      return sent.ok ? ok(existing) : sent;
    }
    const agent = opts.agent ?? this.d.chats.latest(featureId)?.agent ?? this.d.chats.mainAgent();
    const created = this.d.chats.create(featureId, agent, repo);
    if (!created.ok) return created;
    const sent = this.d.chats.send(created.value.id, kickoff(f, r, message, agent, opts.from ?? "the coordinator"));
    if (!sent.ok) return sent;
    appendLog(f.folder, { from: opts.from === "you" ? "you" : "coordinator", to: repo, text: `Started a chat for ${repo}: ${clip(message.split("\n")[0], 200)}` });
    return ok(created.value);
  }

  /** Sends a message to the repo's chat (queued if it is busy). */
  messageRepoChat(featureId: string, repo: string, message: string, from = "the coordinator"): Result<string> {
    const chat = this.d.chats.latest(featureId, repo);
    if (!chat) return fail(`${repo} has no chat yet. Start one with the start-repo-chat tool.`);
    const sent = this.d.chats.send(chat.id, `Message from ${from}:\n${message}`);
    if (!sent.ok) return sent;
    const state = this.d.chats.state(chat.id);
    return ok(state.running ? `Queued for ${repo}'s chat (it is busy; it gets the message when its current turn ends).` : `Sent to ${repo}'s chat.`);
  }

  /** What a repo's chat is doing and what it said last. */
  repoChat(featureId: string, repo: string): string {
    const chat = this.d.chats.latest(featureId, repo);
    if (!chat) return `${repo} has no chat.`;
    const s = this.d.chats.state(chat.id);
    const doing = s.waiting ? "waiting for the user (a question or approval)" : s.running ? "working" : "idle";
    return `${repo}'s chat (${chat.agent ?? "claude"}, ${s.turns} message(s) so far) is ${doing}.${s.lastText ? `\n\nIts last reply:\n${clip(s.lastText, 3000)}` : ""}`;
  }

  /**
   * The agent suggests repos to add. Shown as a card in its chat; nothing is
   * added until the user answers (see answerProposal), and the answer comes
   * back to the chat as a message, so the agent does not wait on a tool call.
   */
  proposeRepos(featureId: string, chatId: string, repos: { name: string; reason: string }[]): Result<string> {
    const f = this.feature(featureId);
    if (!f || f.archived) return fail("Unknown or archived feature.");
    const known = this.d.repos?.(featureId) ?? [];
    const unknown = repos.filter((r) => !known.some((k) => k.name === r.name)).map((r) => r.name);
    if (unknown.length) return fail(`Not repos this feature can have: ${unknown.join(", ")}. The repos it can have are: ${known.map((k) => k.name).join(", ")}.`);
    const fresh = repos.filter((r, i) => !f.repos.some((x) => x.name === r.name) && repos.findIndex((x) => x.name === r.name) === i);
    if (!fresh.length) return fail("Those repos are already in the feature.");
    this.d.chats.propose(chatId, fresh);
    return ok(
      `The user sees your suggestion (${fresh.map((r) => r.name).join(", ")}) and can confirm, correct or decline it. Their answer comes back as a message; until then, do not assume the repos are there.`,
    );
  }

  /** The user's answer to a proposal: adds the chosen repos (worktrees, Jira subtasks) and tells the chat. */
  async answerProposal(featureId: string, chatId: string, id: string, chosen: string[]): Promise<Result<string[]>> {
    const f = this.feature(featureId);
    if (!f) return fail("Unknown feature.");
    const proposed = this.d.chats.openProposal(chatId, id);
    if (!proposed) return fail("That suggestion was already answered.");
    const added: string[] = [];
    const failed: string[] = [];
    for (const name of chosen) {
      if (f.repos.some((r) => r.name === name)) continue;
      const r = (await this.d.addRepo?.(featureId, name)) ?? fail("Adding repos is not available.");
      if (r.ok) added.push(name);
      else failed.push(`${name} (${r.error})`);
    }
    const declined = proposed.map((p) => p.name).filter((n) => !chosen.includes(n));
    this.d.chats.settleProposal(chatId, id, { added, declined, ...(failed.length ? { failed } : {}) });
    const now = this.feature(featureId)!;
    const lines = [
      added.length
        ? `I added ${added.join(", ")} to the feature. Their worktrees: ${added.map((n) => `${n}/ (branch ${now.repos.find((r) => r.name === n)?.branch})`).join(", ")}.`
        : "",
      declined.length ? `Not ${declined.join(", ")}.` : "",
      failed.length ? `Could not add: ${failed.join("; ")}.` : "",
      !added.length && !failed.length ? "None of those, thanks." : "",
    ].filter(Boolean);
    this.d.chats.send(chatId, lines.join("\n"));
    if (added.length) appendLog(f.folder, { from: "you", text: `Added ${added.join(", ")} to the feature.` });
    return ok(added);
  }

  setTitle(featureId: string, title: string): Result<void> {
    return this.d.setTitle?.(featureId, title) ?? fail("Not available.");
  }

  /** A note from the user: logged, and sent to the chats it is for (a repo's, else the central one; "all" = every chat). */
  noteFromUser(featureId: string, to: string | undefined, text: string): Result<string[]> {
    const f = this.feature(featureId);
    if (!f) return fail("Unknown feature.");
    if (!text.trim()) return fail("Write something first.");
    const target = to && to !== "all" ? to : undefined;
    appendLog(f.folder, { from: "you", ...(target ? { to: target } : {}), text });
    const chats = target
      ? [this.d.chats.latest(featureId, target) ?? this.d.chats.latest(featureId)]
      : [this.d.chats.latest(featureId), ...f.repos.map((r) => this.d.chats.latest(featureId, r.name))];
    const delivered: string[] = [];
    for (const c of chats) {
      if (!c || delivered.includes(c.id)) continue;
      const sent = this.d.chats.send(c.id, `Note from the user${target && !c.repo ? ` (about ${target})` : ""}:\n${text}`);
      if (sent.ok) delivered.push(c.id);
    }
    return ok(delivered);
  }

  /** Everything at a glance, as text for an agent (and the user). */
  async status(featureId: string): Promise<string> {
    const f = this.feature(featureId);
    if (!f) return "Unknown feature.";
    const docs = readDocs(f.folder, f.repos.map((r) => r.name));
    const reported = reportedStatuses(docs.log);
    const jira = this.d.jiraOf(featureId);
    const lines = [
      `Feature ${f.name}${f.title ? ` — ${f.title}` : ""} [${f.status ?? "active"}]` +
        `${docs.progress.total ? ` · plan ${docs.progress.done}/${docs.progress.total}` : ""}${jira.task ? ` · Jira ${jira.task}` : ""}`,
      `Folder: ${f.folder}`,
      ...(platformText(f) ? [platformText(f)] : []),
      "",
      "Repos:",
    ];
    for (const r of f.repos) {
      const rep = reported[r.name];
      const chat = this.d.chats.latest(featureId, r.name);
      const cs = chat ? this.d.chats.state(chat.id) : null;
      const facts = await this.d.facts?.(r).catch(() => null);
      const parts = [
        rep ? `reported ${rep.status} (${rep.at}: ${clip(rep.text.split("\n")[0], 120)})` : "nothing reported",
        cs ? `chat ${cs.waiting ? "waiting for the user" : cs.running ? "working" : "idle"}` : "no chat",
        facts
          ? [facts.uncommitted ? `${facts.uncommitted} uncommitted` : "", facts.ahead ? `${facts.ahead} commit(s) ahead` : "", facts.pushed ? "" : "not pushed"]
              .filter(Boolean)
              .join(", ") || "clean"
          : "",
        facts?.pr ? `PR #${facts.pr.number} ${facts.pr.state}, checks ${facts.pr.checks} (${facts.pr.url})` : facts ? "no PR" : "",
        jira.subtasks[r.name] ? `Jira ${jira.subtasks[r.name]}` : "",
      ].filter(Boolean);
      lines.push(`- ${r.name} (${r.branch}): ${parts.join(" · ")}`);
    }
    const open = docs.todos.filter((t) => !t.done);
    if (open.length) {
      lines.push("", `Waiting on the user (todo.md, ${open.length} open):`);
      for (const t of open) lines.push(`- ${t.repo ? `[${t.repo}] ` : ""}${t.title}`);
    }
    const recent = docs.log.slice(-8);
    if (recent.length) {
      lines.push("", "Recent log:");
      for (const e of recent) lines.push(`- ${e.at} ${e.from}${e.to ? ` → ${e.to}` : ""}${e.status ? ` [${e.status}]` : ""}: ${clip(e.text.split("\n")[0], 160)}`);
    }
    return lines.join("\n");
  }
}

/** The first message of a repo chat: the task, and how to work in a Caboose feature. */
export function kickoff(f: Feature, r: FeatureRepo, task: string, agent: Agent, from: string): string {
  const t = TOOL_NAMES[agent];
  return [
    `You are the agent for the ${r.name} repo in the feature "${f.title || f.name}" (${f.name}).`,
    `Your worktree is ${r.path}, on branch ${r.branch}. Other repos of the feature are other agents' work: do not change them.`,
    `Read the feature's files first, whichever exist: ${f.folder}/brief.md (the goal), ${f.folder}/plan.md, and ${f.folder}/briefs/${r.name}.md (your part).`,
    `Report as you go with ${t.status} (working when you start; needs-input or blocked when stuck; ready when your work is committed locally; in-review once a PR exists; done when merged), and use ${t.log} for decisions worth keeping. When you need a decision, ask the user directly with ${t.ask}; they see it in Caboose.`,
    "Do not push, open pull requests or change Jira unless you are asked to.",
    "",
    `Your task (from ${from}):`,
    task,
  ].join("\n");
}
