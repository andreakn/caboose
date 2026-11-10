// Claude Code through the Claude Agent SDK, which runs the official Claude
// Code binary under the user's own login. The SDK's query() is passed in so
// tests can fake it.
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_MODELS, type Chat, type ChatCommand, type Effort, type Question } from "../../../shared/chat.ts";
import type { Feature } from "../../../shared/types.ts";
import { type AgentHost, type AgentProvider, type AgentSession, chatCwd, clip, errorText } from "./types.ts";

/** The part of the SDK's Query that Caboose uses. */
export type QueryLike = AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: Effort | null }): Promise<void>;
  /** The session's slash commands (skills, project commands, Claude Code's own); known once it has started. */
  supportedCommands?(): Promise<SlashCommand[]>;
  close(): void;
};
export type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;
/** Extra query options per chat: Caboose's MCP tools and system prompt. */
export type ExtraOptions = (chat: Chat, feature: Feature) => Partial<Options>;

/** How long a folder's command list is trusted (skills added on disk show up after this, or with a new session). */
const COMMANDS_TTL_MS = 5 * 60_000;

/** The commands worth offering: not internal ones, nor removed or renamed ones. */
export function chatCommands(list: SlashCommand[]): ChatCommand[] {
  const seen = new Set<string>();
  return list.flatMap((c) => {
    if (c.name.startsWith("_") || seen.has(c.name) || /^\((removed|deprecated)\)|^Renamed to /i.test(c.description)) return [];
    seen.add(c.name);
    return [{ name: c.name, description: c.description, ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}) }];
  });
}

/** What marks an agent session as Caboose's, for the user's hooks and scripts. */
export function cabooseEnv(feature: Feature, chat: Chat): Record<string, string> {
  return { CABOOSE: "1", CABOOSE_FEATURE: feature.name, ...(chat.repo ? { CABOOSE_REPO: chat.repo } : {}) };
}

export class ClaudeProvider implements AgentProvider {
  private query: QueryFn;
  private extras: ExtraOptions;
  private commandCache = new Map<string, { at: number; value: Promise<ChatCommand[]> }>();

  constructor(query: QueryFn, extras: ExtraOptions = () => ({})) {
    this.query = query;
    this.extras = extras;
  }

  async models() {
    return CLAUDE_MODELS;
  }

  /**
   * The slash commands for a folder. Without a running session there, a
   * session is started only to ask (no message is sent, so nothing is spent)
   * and closed again; it takes a fraction of a second.
   */
  commands(cwd: string): Promise<ChatCommand[]> {
    const hit = this.commandCache.get(cwd);
    if (hit && Date.now() - hit.at < COMMANDS_TTL_MS) return hit.value;
    const value = (async () => {
      const inbox = new Inbox<SDKUserMessage>();
      const q = this.query({ prompt: inbox, options: { cwd } });
      try {
        if (!q.supportedCommands) return [];
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 15_000));
        return chatCommands(await Promise.race([q.supportedCommands(), timeout]));
      } finally {
        inbox.end();
        q.close();
      }
    })();
    this.commandCache.set(cwd, { at: Date.now(), value });
    value.catch(() => this.commandCache.delete(cwd));
    return value;
  }

  start(chat: Chat, feature: Feature, host: AgentHost): AgentSession {
    const inbox = new Inbox<SDKUserMessage>();
    const q = this.query({
      prompt: inbox,
      options: {
        ...this.extras(chat, feature),
        cwd: chatCwd(chat, feature),
        // Hooks and scripts can tell a Caboose session (and which feature) from others: CABOOSE=1.
        env: { ...process.env, ...cabooseEnv(feature, chat) },
        // A repo chat also reads the feature's files (brief, plan, its brief) one folder up.
        ...(chat.repo ? { additionalDirectories: [feature.folder] } : {}),
        resume: chat.sessionId,
        model: chat.model === "default" ? undefined : chat.model,
        effort: chat.effort,
        permissionMode: chat.mode,
        allowDangerouslySkipPermissions: true, // lets the user switch to bypass mid-session
        includePartialMessages: true,
        thinking: { type: "adaptive", display: "summarized" },
        canUseTool: canUseTool(host),
      },
    });
    // A live session knows its commands: keep the folder's list fresh for free.
    const cwd = chatCwd(chat, feature);
    void q
      .supportedCommands?.()
      .then((list) => this.commandCache.set(cwd, { at: Date.now(), value: Promise.resolve(chatCommands(list)) }))
      .catch(() => {});
    let closed = false;
    void consume(q, host).then((error) => {
      if (!closed) host.ended(error);
    });
    return {
      send: (text) => inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }),
      interrupt: async () => void (await q.interrupt()),
      configure: async (patch) => {
        if (patch.model) await q.setModel(patch.model === "default" ? undefined : patch.model);
        if (patch.mode) await q.setPermissionMode(patch.mode);
        if (patch.effort) await q.applyFlagSettings({ effortLevel: patch.effort });
      },
      close: () => {
        closed = true;
        inbox.end();
        q.close();
      },
    };
  }
}

/** Reads the session's messages until the process ends; resolves with an error message if it failed. */
async function consume(q: QueryLike, host: AgentHost): Promise<string | undefined> {
  let draft: { kind: "text" | "thinking"; text: string } | undefined;
  try {
    for await (const m of q) {
      // Subagents' own messages stay out of the main transcript; their report
      // comes back as the Agent tool's result.
      if ("parent_tool_use_id" in m && m.parent_tool_use_id) continue;
      switch (m.type) {
        case "system":
          if (m.subtype === "init") host.sessionId(m.session_id);
          break;
        case "stream_event": {
          const ev = m.event;
          if (ev.type === "content_block_start" && (ev.content_block.type === "text" || ev.content_block.type === "thinking")) {
            draft = { kind: ev.content_block.type, text: "" };
          } else if (ev.type === "content_block_delta" && draft) {
            if (ev.delta.type === "text_delta") draft.text += ev.delta.text;
            else if (ev.delta.type === "thinking_delta") draft.text += ev.delta.thinking;
            else break;
            host.draft(draft.kind, draft.text);
          }
          break;
        }
        case "assistant":
          draft = undefined;
          m.message.content.forEach((b, i) => {
            const id = `${m.uuid}:${i}`;
            if (b.type === "text" && b.text) host.text(id, b.text);
            else if (b.type === "thinking" && b.thinking) host.thinking(id, b.thinking);
            else if (b.type === "tool_use") host.tool(b.id, b.name, b.input);
          });
          break;
        case "user": {
          const content = m.message.content;
          if (typeof content === "string") break;
          for (const b of content) {
            if (b.type === "tool_result") host.toolResult(b.tool_use_id, clip(resultText(b.content)), Boolean(b.is_error));
          }
          break;
        }
        case "result": {
          draft = undefined;
          const ok = m.subtype === "success" && !m.is_error;
          const error = ok ? undefined : m.subtype === "success" ? m.result : m.errors?.join("\n") || m.subtype;
          host.turnEnd({ ok, durationMs: m.duration_ms, turns: m.num_turns, error });
          break;
        }
      }
    }
    return undefined;
  } catch (e) {
    return errorText(e);
  }
}

function canUseTool(host: AgentHost): CanUseTool {
  return async (tool, input, { signal, suggestions, decisionReason }): Promise<PermissionResult> => {
    // Caboose's own tools only read the diff or write review comments.
    if (tool.startsWith("mcp__caboose__")) return { behavior: "allow", updatedInput: input };
    if (tool === "AskUserQuestion") {
      const answer = await host.askQuestions((input.questions ?? []) as Question[], signal);
      if (answer && "repliedInChat" in answer) {
        return {
          behavior: "deny",
          message: `The user did not pick an option and replied instead: ${JSON.stringify(answer.repliedInChat)}`,
        };
      }
      return answer
        ? { behavior: "allow", updatedInput: { ...input, answers: answer } }
        : { behavior: "deny", message: "The user dismissed the question without answering." };
    }
    const answer = await host.askPermission(tool, input, signal, decisionReason);
    if (answer === "deny") return { behavior: "deny", message: "The user said no." };
    return {
      behavior: "allow",
      updatedInput: input,
      ...(answer === "always" && suggestions ? { updatedPermissions: suggestions } : {}),
    };
  };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** An async iterable that is fed by push() and finished by end(). */
export class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}
