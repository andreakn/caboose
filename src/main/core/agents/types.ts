// The seam between Caboose's chat engine and a coding agent (Claude Code,
// GitHub Copilot). The engine owns transcripts, queueing, approvals and
// questions; an agent adapter only translates its SDK to these calls.
import type { Chat, ChatCommand, Effort, Mode, Model, ModelOption, Question } from "../../../shared/chat.ts";
import type { Feature } from "../../../shared/types.ts";

export type PermissionAnswer = "allow" | "always" | "deny";
/** answers by question text; or the user typed a reply in the chat instead; or dismissed (null). */
export type QuestionAnswer = Record<string, string> | { repliedInChat: string } | null;

/** What an agent session reports to the chat engine. */
export interface AgentHost {
  /** The agent's own session id, kept for resuming after a restart. */
  sessionId(id: string): void;
  /** Streaming text or thinking so far (the whole block, not a delta). */
  draft(kind: "text" | "thinking", text: string): void;
  text(id: string, text: string): void;
  thinking(id: string, text: string): void;
  tool(id: string, name: string, input: unknown): void;
  toolResult(id: string, content: string, isError: boolean): void;
  /** The turn is over (also after an interrupt). */
  turnEnd(r: { ok: boolean; durationMs: number; turns: number; error?: string }): void;
  /** The session died; it is started again on the next message. */
  ended(error?: string): void;
  /** Shows an approval card; resolves when the user answers (deny if the session ends). */
  /** `reason`: why the agent asks (a hook's or a rule's explanation), when it says. */
  askPermission(tool: string, input: unknown, signal?: AbortSignal, reason?: string): Promise<PermissionAnswer>;
  /** Shows a question card; resolves when the user answers. */
  askQuestions(questions: Question[], signal?: AbortSignal): Promise<QuestionAnswer>;
}

export interface AgentSession {
  send(text: string): void;
  interrupt(): Promise<void>;
  configure(patch: { model?: Model; effort?: Effort; mode?: Mode }): Promise<void>;
  close(): void;
}

export interface AgentProvider {
  start(chat: Chat, feature: Feature, host: AgentHost): AgentSession;
  models(): Promise<ModelOption[]>;
  /** The slash commands a session working in `cwd` offers (none where the agent cannot list them). */
  commands?(cwd: string): Promise<ChatCommand[]>;
}

/** Where a chat's agent works: its repo's worktree, or the feature folder for the central chat. */
export function chatCwd(chat: Chat, feature: Feature): string {
  return (chat.repo && feature.repos.find((r) => r.name === chat.repo)?.path) || feature.folder;
}

export const MAX_RESULT_CHARS = 20_000;

export function clip(s: string): string {
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (${s.length - MAX_RESULT_CHARS} more characters)` : s;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
