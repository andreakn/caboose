// The chat transcript format. The main process turns SDK messages into these
// events, saves the lasting ones as JSONL, and the renderer folds them into
// items with `applyEvent`. One format for live streaming and for replay.

/** Which coding agent runs a chat. */
export type Agent = "claude" | "copilot";
export const AGENTS: { value: Agent; label: string }[] = [
  { value: "claude", label: "Claude Code" },
  { value: "copilot", label: "GitHub Copilot" },
];

/** "default", or a model id/alias the chat's agent understands. */
export type Model = string;
/** A slash command a chat's agent offers (a skill, a project command, one of Claude Code's own). */
export type ChatCommand = { name: string; description: string; argumentHint?: string };

export type ModelOption = { value: Model; label: string; efforts?: Effort[] };
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type Mode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

/** Claude Code's model aliases. Copilot's come from the user's plan at runtime. */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "default", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "default", label: "Ask before acting", hint: "Asks before edits and commands (reading files in the feature is free)." },
  { value: "acceptEdits", label: "Accept edits", hint: "File edits inside the feature go through; commands, web and MCP tools ask." },
  { value: "plan", label: "Plan only", hint: "The agent plans and reads, and changes nothing." },
  { value: "bypassPermissions", label: "Bypass permissions", hint: "Never asks (as in Conductor). The worktree isolates git work, not your machine." },
];

export type Chat = {
  id: string;
  featureId: string;
  /** Missing on chats from before Copilot support: those are Claude. */
  agent?: Agent;
  /** A repo chat works in that repo's worktree; without it, the chat is the feature's central chat (the feature folder). */
  repo?: string;
  title: string;
  /** The agent's session id, set once the first turn starts; used to resume. */
  sessionId?: string;
  model: Model;
  effort: Effort;
  mode: Mode;
  createdAt: string;
};

/** Events that are saved and replayed. */
export type LastingEvent =
  | { t: "user"; id: string; text: string; at: string }
  | { t: "text"; id: string; text: string }
  | { t: "thinking"; id: string; text: string }
  | { t: "tool"; id: string; name: string; input: unknown }
  | { t: "tool_result"; id: string; content: string; isError: boolean }
  | { t: "permission"; id: string; tool: string; input: unknown; /** Why it is asked (a hook's reason, a rule), when the agent says. */ reason?: string }
  | { t: "permission_answer"; id: string; allowed: boolean }
  | { t: "question"; id: string; questions: Question[] }
  /** null: the user dismissed the questions or replied in the chat instead. */
  | { t: "question_answer"; id: string; answers: Record<string, string> | null }
  /** The agent suggests repos to add to the feature; the user confirms, corrects or declines. */
  | { t: "proposal"; id: string; repos: { name: string; reason: string }[] }
  | { t: "proposal_answer"; id: string; added: string[]; declined: string[]; failed?: string[] }
  | { t: "result"; id: string; ok: boolean; durationMs: number; turns: number; error?: string }
  | { t: "error"; id: string; text: string }
  /** Above here: the conversation in the archived feature this one continues; the agent starts a new session. */
  | { t: "continued"; id: string; from: string; archivedAt: string; history?: string; at?: string };

/** Events that only matter while the app is open. */
export type LiveEvent =
  | { t: "draft"; kind: "text" | "thinking"; text: string }
  | { t: "draft_clear" }
  | { t: "status"; running: boolean; queued: string[] };

export type ChatEvent = LastingEvent | LiveEvent;

/** Saved events carry the time they happened (older transcripts may not). */
export const eventTime = (e: ChatEvent): string | undefined => (e as { at?: string }).at;

/** One question from Claude Code's AskUserQuestion tool. */
export type Question = {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
};

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "continued"; id: string; from: string; archivedAt: string; history?: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: { content: string; isError: boolean } }
  | { kind: "permission"; id: string; tool: string; input: unknown; reason?: string; answer?: boolean }
  | { kind: "question"; id: string; questions: Question[]; answered: boolean; answers: Record<string, string> | null }
  | {
      kind: "proposal";
      id: string;
      repos: { name: string; reason: string }[];
      answer?: { added: string[]; declined: string[]; failed?: string[] };
    }
  | { kind: "result"; id: string; ok: boolean; durationMs: number; turns: number; error?: string }
  | { kind: "error"; id: string; text: string };

export type ChatView = {
  items: ChatItem[];
  draft?: { kind: "text" | "thinking"; text: string };
  running: boolean;
  queued: string[];
};

export const emptyView = (): ChatView => ({ items: [], running: false, queued: [] });

export function applyEvent(v: ChatView, e: ChatEvent): ChatView {
  switch (e.t) {
    case "user":
      return { ...v, items: [...v.items, { kind: "user", id: e.id, text: e.text }] };
    case "text":
    case "thinking":
      return { ...v, draft: undefined, items: upsert(v.items, { kind: e.t, id: e.id, text: e.text }) };
    case "tool":
      return { ...v, items: upsert(v.items, { kind: "tool", id: e.id, name: e.name, input: e.input }) };
    case "tool_result":
      return {
        ...v,
        items: v.items.map((i) =>
          i.kind === "tool" && i.id === e.id ? { ...i, result: { content: e.content, isError: e.isError } } : i,
        ),
      };
    case "permission":
      return { ...v, items: upsert(v.items, { kind: "permission", id: e.id, tool: e.tool, input: e.input, ...(e.reason ? { reason: e.reason } : {}) }) };
    case "continued":
      return { ...v, items: [...v.items, { kind: "continued", id: e.id, from: e.from, archivedAt: e.archivedAt, ...(e.history ? { history: e.history } : {}) }] };
    case "permission_answer":
      return {
        ...v,
        items: v.items.map((i) => (i.kind === "permission" && i.id === e.id ? { ...i, answer: e.allowed } : i)),
      };
    case "question":
      return {
        ...v,
        items: upsert(v.items, { kind: "question", id: e.id, questions: e.questions, answered: false, answers: null }),
      };
    case "proposal":
      return { ...v, items: upsert(v.items, { kind: "proposal", id: e.id, repos: e.repos }) };
    case "proposal_answer":
      return {
        ...v,
        items: v.items.map((i) =>
          i.kind === "proposal" && i.id === e.id ? { ...i, answer: { added: e.added, declined: e.declined, failed: e.failed } } : i,
        ),
      };
    case "question_answer":
      return {
        ...v,
        items: v.items.map((i) => (i.kind === "question" && i.id === e.id ? { ...i, answered: true, answers: e.answers } : i)),
      };
    case "result":
      return {
        ...v,
        draft: undefined,
        items: [
          ...v.items,
          { kind: "result", id: e.id, ok: e.ok, durationMs: e.durationMs, turns: e.turns, ...(e.error ? { error: e.error } : {}) },
        ],
      };
    case "error":
      return { ...v, draft: undefined, items: [...v.items, { kind: "error", id: e.id, text: e.text }] };
    case "draft":
      return { ...v, draft: { kind: e.kind, text: e.text } };
    case "draft_clear":
      return { ...v, draft: undefined };
    case "status":
      return { ...v, running: e.running, queued: e.queued };
  }
}

function upsert(items: ChatItem[], item: ChatItem): ChatItem[] {
  const i = items.findIndex((x) => x.id === item.id && x.kind === item.kind);
  if (i < 0) return [...items, item];
  const copy = items.slice();
  copy[i] = item;
  return copy;
}

/**
 * What a shell command does that is worth a second look before allowing it,
 * found anywhere in it (also inside a script it writes and runs): so a long
 * command that commits, pushes or posts says so on its first line.
 */
export function shellEffects(command: string): string[] {
  const has = (re: RegExp) => re.test(command);
  const git = (verb: string) => new RegExp(`\\bgit\\b(?:\\s+-{1,2}[^\\s]+(?:\\s+[^-\\s][^\\s]*)?)*\\s+${verb}\\b`);
  return [
    has(git("commit")) && "commits",
    has(git("push")) && "pushes",
    (has(git("reset\\s+--hard")) || has(git("checkout\\s+--?\\s")) || has(git("clean\\s+-[a-z]*f"))) && "discards changes",
    has(/\bgh\s+pr\s+(create|merge|close|comment|review|edit)\b/) && "changes a PR",
    has(/\bgh\s+api\b[^\n]*(\s-f\s|\s-F\s|--field|--raw-field|-X\s*(POST|PATCH|PUT|DELETE)|--method\s+(POST|PATCH|PUT|DELETE))/) && "posts to GitHub",
    has(/\brm\s+-[a-zA-Z]*[rf]/) && "deletes files",
    has(/\b(kubectl|helm)\s+(apply|delete|rollout|scale|patch|edit|set)\b/) && "changes a cluster",
    has(/\bcurl\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|\s-d\s|--data)/) && "sends data",
  ].filter((x): x is string => Boolean(x));
}

/**
 * A finished conversation: permissions, questions and repo proposals still
 * open when it ended are closed, so nothing in it looks answerable.
 */
export function closeOpen(events: LastingEvent[]): LastingEvent[] {
  const answered = new Set(events.flatMap((e) => (e.t === "permission_answer" || e.t === "question_answer" || e.t === "proposal_answer" ? [e.id] : [])));
  const closing = events.flatMap((e): LastingEvent[] =>
    answered.has(e.id)
      ? []
      : e.t === "permission"
        ? [{ t: "permission_answer", id: e.id, allowed: false }]
        : e.t === "question"
          ? [{ t: "question_answer", id: e.id, answers: null }]
          : e.t === "proposal"
            ? [{ t: "proposal_answer", id: e.id, added: [], declined: [] }]
            : [],
  );
  return [...events, ...closing];
}

/** What a chat shows besides the conversation itself (which is always shown). */
export type ChatShow = { notes: boolean; thinking: boolean; tools: boolean };
export const SHOW_ALL: ChatShow = { notes: true, thinking: true, tools: true };

/** Steps of a finished turn that are not shown: a line to open them. `turn` names the turn (its first item). */
export type HiddenSteps = { kind: "hidden"; id: string; turn: string; notes: number; thinking: number; tools: number };

/**
 * The items to show. Always: what the user wrote, each finished turn's last
 * message (its answer), and everything that needs the user or says what
 * happened (questions, permissions, proposals, errors, results). The agent's
 * other messages (progress notes), its thinking and its tool calls only as
 * `show` says; what a finished turn hides is summed up in one line, which
 * opens that turn (`open`). A running turn hides them without a line: the
 * working indicator says what it is doing.
 */
export function visibleItems(items: ChatItem[], running: boolean, show: ChatShow, open: Set<string> = new Set()): (ChatItem | HiddenSteps)[] {
  if (show.notes && show.thinking && show.tools) return items;
  // Turns: from a user message to the next one (the first may start without one).
  const turns: ChatItem[][] = [];
  for (const it of items) {
    if (it.kind === "user" || !turns.length) turns.push([]);
    turns.at(-1)!.push(it);
  }
  const out: (ChatItem | HiddenSteps)[] = [];
  turns.forEach((turn, n) => {
    const key = `${turn[0].kind}:${turn[0].id}`;
    const live = running && n === turns.length - 1;
    if (open.has(key)) return void out.push(...turn);
    const texts = turn.filter((i) => i.kind === "text");
    const answer = live ? undefined : texts.at(-1);
    const hidden = { notes: 0, thinking: 0, tools: 0 };
    const kept: (ChatItem | HiddenSteps)[] = [];
    for (const it of turn) {
      if (it.kind === "text" && it !== answer && !show.notes) hidden.notes++;
      else if (it.kind === "thinking" && !show.thinking) hidden.thinking++;
      else if (it.kind === "tool" && !show.tools) hidden.tools++;
      else kept.push(it);
    }
    const any = hidden.notes + hidden.thinking + hidden.tools > 0;
    if (!any || live) return void out.push(...kept);
    // The line goes where the hidden steps were: before the answer (or the turn's end).
    const at = answer ? kept.indexOf(answer) : kept.findIndex((i) => i.kind === "result");
    const line: HiddenSteps = { kind: "hidden", id: key, turn: key, ...hidden };
    if (at < 0) kept.push(line);
    else kept.splice(at, 0, line);
    out.push(...kept);
  });
  return out;
}

/** What the agent is doing now, from the running turn's latest step ("" when nothing has happened yet). */
export function currentActivity(items: ChatItem[]): ChatItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return undefined;
    if (it.kind === "tool" || it.kind === "thinking" || it.kind === "text") return it;
  }
  return undefined;
}

/** "Bash", "Edit", or an MCP tool's own name ("mcp__caboose__AddTodo" → "AddTodo"). */
const shortTool = (name: string) => name.replace(/^mcp__[^_]+__/, "");
const firstLine = (s: string, max = 160) => {
  const line = s.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What a notification says about a chat event: the question asked, what
 * approval is for (and why it asks), or how the turn ended (the start of
 * its last message, or the error). `lastText` is the chat's latest message.
 */
export function noticeBody(e: LastingEvent, lastText?: string): string {
  switch (e.t) {
    case "question": {
      const q = e.questions[0]?.question ?? "A question";
      return e.questions.length > 1 ? `${firstLine(q)} (and ${e.questions.length - 1} more)` : firstLine(q);
    }
    case "permission": {
      const input = (e.input ?? {}) as Record<string, unknown>;
      const what =
        typeof input.description === "string"
          ? input.description
          : typeof input.command === "string"
            ? input.command
            : typeof input.file_path === "string"
              ? input.file_path
              : "";
      const ask = `Wants to use ${shortTool(e.tool)}${what ? `: ${firstLine(what, 120)}` : ""}`;
      return e.reason ? `${ask}. ${firstLine(e.reason, 120)}` : ask;
    }
    case "result":
      if (!e.ok) return `Stopped: ${firstLine(e.error ?? "it failed")}`;
      return lastText ? firstLine(lastText) : "Done.";
    default:
      return "";
  }
}
