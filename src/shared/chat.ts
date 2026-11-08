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
  | { t: "permission"; id: string; tool: string; input: unknown }
  | { t: "permission_answer"; id: string; allowed: boolean }
  | { t: "question"; id: string; questions: Question[] }
  /** null: the user dismissed the questions or replied in the chat instead. */
  | { t: "question_answer"; id: string; answers: Record<string, string> | null }
  /** The agent suggests repos to add to the feature; the user confirms, corrects or declines. */
  | { t: "proposal"; id: string; repos: { name: string; reason: string }[] }
  | { t: "proposal_answer"; id: string; added: string[]; declined: string[]; failed?: string[] }
  | { t: "result"; id: string; ok: boolean; durationMs: number; turns: number; error?: string }
  | { t: "error"; id: string; text: string };

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
  | { kind: "text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: { content: string; isError: boolean } }
  | { kind: "permission"; id: string; tool: string; input: unknown; answer?: boolean }
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
      return { ...v, items: upsert(v.items, { kind: "permission", id: e.id, tool: e.tool, input: e.input }) };
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
