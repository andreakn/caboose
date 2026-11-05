// Chats with Claude: one Claude Code session per chat, run through the Agent
// SDK (which runs the official Claude Code binary under the user's own login).
// Electron-free; the SDK's query() is passed in so tests can fake it.
import type {
  CanUseTool,
  Options,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Chat, ChatEvent, Effort, LastingEvent, Mode, Model } from "../../shared/chat.ts";
import type { Result } from "../../shared/types.ts";
import type { Store } from "./store.ts";

/** The part of the SDK's Query that Caboose uses. */
export type QueryLike = AsyncIterable<SDKMessage> & {
  interrupt(): Promise<unknown>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  applyFlagSettings(settings: { effortLevel?: Effort | null }): Promise<void>;
  close(): void;
};
export type QueryFn = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => QueryLike;

type Pending = { input: Record<string, unknown>; suggestions?: PermissionUpdate[]; resolve: (r: PermissionResult) => void };

type Live = {
  q: QueryLike;
  inbox: Inbox<SDKUserMessage>;
  running: boolean;
  queue: string[];
  draft?: { kind: "text" | "thinking"; text: string };
  permissions: Map<string, Pending>;
};

const DEFAULTS = { model: "default" as Model, effort: "high" as Effort, mode: "acceptEdits" as Mode };
const MAX_RESULT_CHARS = 20_000;

export class Chats {
  private store: Store;
  private dir: string;
  private query: QueryFn;
  private emit: (chatId: string, e: ChatEvent) => void;
  private live = new Map<string, Live>();

  constructor(store: Store, dataDir: string, query: QueryFn, emit: (chatId: string, e: ChatEvent) => void) {
    this.store = store;
    this.dir = join(dataDir, "chats");
    this.query = query;
    this.emit = emit;
  }

  /** A new chat, with the settings of the workspace's most recent one. */
  create(workspaceId: string): Result<Chat> {
    const ws = this.store.get().workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { ok: false, error: "Unknown workspace." };
    const last = this.store.get().chats.filter((c) => c.workspaceId === workspaceId).at(-1);
    const chat: Chat = {
      id: randomUUID(),
      workspaceId,
      title: "New chat",
      model: last?.model ?? DEFAULTS.model,
      effort: last?.effort ?? DEFAULTS.effort,
      mode: last?.mode ?? DEFAULTS.mode,
      createdAt: new Date().toISOString(),
    };
    this.store.update((s) => ({ ...s, chats: [...s.chats, chat] }));
    return { ok: true, value: chat };
  }

  /** The saved transcript plus the live state, for (re)opening a chat. */
  events(chatId: string): ChatEvent[] {
    const file = this.file(chatId);
    const saved: ChatEvent[] = existsSync(file)
      ? readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as ChatEvent)
      : [];
    const live = this.live.get(chatId);
    if (live) {
      saved.push({ t: "status", running: live.running, queued: [...live.queue] });
      if (live.draft) saved.push({ t: "draft", ...live.draft });
    }
    return saved;
  }

  send(chatId: string, text: string): Result<void> {
    const chat = this.chat(chatId);
    if (!chat) return { ok: false, error: "Unknown chat." };
    if (!text.trim()) return { ok: true, value: undefined };
    let live = this.live.get(chatId);
    if (!live) {
      const started = this.start(chat);
      if (!started.ok) return started;
      live = started.value;
    }
    if (live.running) {
      live.queue.push(text);
      this.status(chatId, live);
    } else {
      this.deliver(chat, live, text);
    }
    return { ok: true, value: undefined };
  }

  /** Stops the current turn and drops queued messages. The session stays usable. */
  async interrupt(chatId: string): Promise<void> {
    const live = this.live.get(chatId);
    if (!live) return;
    live.queue = [];
    this.denyAll(chatId, live, "The user stopped this turn.");
    this.status(chatId, live);
    await live.q.interrupt().catch(() => {});
  }

  answerPermission(chatId: string, id: string, answer: "allow" | "always" | "deny"): void {
    const live = this.live.get(chatId);
    const p = live?.permissions.get(id);
    if (!live || !p) return;
    live.permissions.delete(id);
    this.record(chatId, { t: "permission_answer", id, allowed: answer !== "deny" });
    p.resolve(
      answer === "deny"
        ? { behavior: "deny", message: "The user said no." }
        : {
            behavior: "allow",
            updatedInput: p.input,
            ...(answer === "always" && p.suggestions ? { updatedPermissions: p.suggestions } : {}),
          },
    );
  }

  async configure(chatId: string, patch: { model?: Model; effort?: Effort; mode?: Mode }): Promise<void> {
    if (!this.chat(chatId)) return;
    this.patch(chatId, patch);
    const live = this.live.get(chatId);
    if (!live) return;
    if (patch.model) await live.q.setModel(patch.model === "default" ? undefined : patch.model).catch(() => {});
    if (patch.mode) await live.q.setPermissionMode(patch.mode).catch(() => {});
    if (patch.effort) await live.q.applyFlagSettings({ effortLevel: patch.effort }).catch(() => {});
  }

  /** Closes the tab: ends its session and forgets the transcript. */
  remove(chatId: string): void {
    this.stop(chatId);
    this.store.update((s) => ({ ...s, chats: s.chats.filter((c) => c.id !== chatId) }));
    rmSync(this.file(chatId), { force: true });
  }

  /** Ends every session in a workspace (it is being archived). Transcripts stay. */
  stopWorkspace(workspaceId: string): void {
    for (const c of this.store.get().chats) if (c.workspaceId === workspaceId) this.stop(c.id);
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id);
  }

  private stop(chatId: string): void {
    const live = this.live.get(chatId);
    if (!live) return;
    this.live.delete(chatId);
    this.denyAll(chatId, live, "The session was closed.");
    live.inbox.end();
    try {
      live.q.close();
    } catch {
      // already gone
    }
  }

  private start(chat: Chat): Result<Live> {
    const ws = this.store.get().workspaces.find((w) => w.id === chat.workspaceId);
    if (!ws || ws.archived) return { ok: false, error: "This workspace is archived." };
    const inbox = new Inbox<SDKUserMessage>();
    const live: Live = { q: undefined as unknown as QueryLike, inbox, running: false, queue: [], permissions: new Map() };
    live.q = this.query({
      prompt: inbox,
      options: {
        cwd: ws.path,
        resume: chat.sessionId,
        model: chat.model === "default" ? undefined : chat.model,
        effort: chat.effort,
        permissionMode: chat.mode,
        allowDangerouslySkipPermissions: true, // lets the user switch to bypass mid-session
        includePartialMessages: true,
        thinking: { type: "adaptive", display: "summarized" },
        canUseTool: this.canUseTool(chat.id),
      },
    });
    this.live.set(chat.id, live);
    void this.consume(chat.id, live);
    return { ok: true, value: live };
  }

  private deliver(chat: Chat, live: Live, text: string): void {
    if (chat.title === "New chat") this.patch(chat.id, { title: titleFrom(text) });
    this.record(chat.id, { t: "user", id: randomUUID(), text, at: new Date().toISOString() });
    live.running = true;
    this.status(chat.id, live);
    live.inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  private async consume(chatId: string, live: Live): Promise<void> {
    try {
      for await (const m of live.q) this.handle(chatId, live, m);
    } catch (e) {
      if (this.live.get(chatId) === live) this.record(chatId, { t: "error", id: randomUUID(), text: errorText(e) });
    }
    // The Claude Code process has ended (closed, crashed or logged out).
    if (this.live.get(chatId) === live) {
      this.live.delete(chatId);
      this.denyAll(chatId, live, "The session ended.");
      if (live.running) this.emit(chatId, { t: "draft_clear" });
      this.emit(chatId, { t: "status", running: false, queued: [] });
    }
  }

  private handle(chatId: string, live: Live, m: SDKMessage): void {
    // Subagents' own messages stay out of the main transcript; their report
    // comes back as the Agent tool's result.
    if ("parent_tool_use_id" in m && m.parent_tool_use_id) return;

    switch (m.type) {
      case "system":
        if (m.subtype === "init" && this.chat(chatId)?.sessionId !== m.session_id) {
          this.patch(chatId, { sessionId: m.session_id });
        }
        return;

      case "stream_event": {
        const ev = m.event;
        if (ev.type === "content_block_start" && (ev.content_block.type === "text" || ev.content_block.type === "thinking")) {
          live.draft = { kind: ev.content_block.type, text: "" };
        } else if (ev.type === "content_block_delta" && live.draft) {
          if (ev.delta.type === "text_delta") live.draft.text += ev.delta.text;
          else if (ev.delta.type === "thinking_delta") live.draft.text += ev.delta.thinking;
          else return;
          this.emit(chatId, { t: "draft", ...live.draft });
        }
        return;
      }

      case "assistant":
        live.draft = undefined;
        m.message.content.forEach((b, i) => {
          const id = `${m.uuid}:${i}`;
          if (b.type === "text" && b.text) this.record(chatId, { t: "text", id, text: b.text });
          else if (b.type === "thinking" && b.thinking) this.record(chatId, { t: "thinking", id, text: b.thinking });
          else if (b.type === "tool_use") this.record(chatId, { t: "tool", id: b.id, name: b.name, input: b.input });
        });
        this.emit(chatId, { t: "draft_clear" });
        return;

      case "user": {
        const content = m.message.content;
        if (typeof content === "string") return;
        for (const b of content) {
          if (b.type === "tool_result") {
            this.record(chatId, {
              t: "tool_result",
              id: b.tool_use_id,
              content: resultText(b.content),
              isError: Boolean(b.is_error),
            });
          }
        }
        return;
      }

      case "result": {
        const ok = m.subtype === "success" && !m.is_error;
        const error = ok ? undefined : m.subtype === "success" ? m.result : m.errors?.join("\n") || m.subtype;
        live.draft = undefined;
        this.record(chatId, {
          t: "result",
          id: m.uuid,
          ok,
          durationMs: m.duration_ms,
          turns: m.num_turns,
          ...(error ? { error } : {}),
        });
        live.running = false;
        const next = live.queue.shift();
        const chat = this.chat(chatId);
        if (next !== undefined && chat) this.deliver(chat, live, next);
        else this.status(chatId, live);
        return;
      }
    }
  }

  private canUseTool(chatId: string): CanUseTool {
    return (tool, input, { signal, suggestions }) => {
      if (tool === "AskUserQuestion") {
        // Phase 4 gives this a real UI.
        return Promise.resolve({
          behavior: "deny",
          message: "Caboose cannot show multiple-choice questions yet. Ask in plain text and end your turn.",
        });
      }
      const live = this.live.get(chatId);
      if (!live) return Promise.resolve({ behavior: "deny", message: "The session was closed." });
      const id = randomUUID();
      return new Promise<PermissionResult>((resolve) => {
        live.permissions.set(id, { input, suggestions, resolve });
        this.record(chatId, { t: "permission", id, tool, input });
        signal.addEventListener("abort", () => {
          if (live.permissions.delete(id)) {
            this.record(chatId, { t: "permission_answer", id, allowed: false });
            resolve({ behavior: "deny", message: "Cancelled." });
          }
        });
      });
    };
  }

  private denyAll(chatId: string, live: Live, message: string): void {
    for (const [id, p] of live.permissions) {
      this.record(chatId, { t: "permission_answer", id, allowed: false });
      p.resolve({ behavior: "deny", message, interrupt: true });
    }
    live.permissions.clear();
  }

  private status(chatId: string, live: Live): void {
    this.emit(chatId, { t: "status", running: live.running, queued: [...live.queue] });
  }

  /** Saves a lasting event and sends it to the window. */
  private record(chatId: string, e: LastingEvent): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(chatId), `${JSON.stringify(e)}\n`);
    this.emit(chatId, e);
  }

  private file(chatId: string): string {
    return join(this.dir, `${chatId}.jsonl`);
  }

  private chat(chatId: string): Chat | undefined {
    return this.store.get().chats.find((c) => c.id === chatId);
  }

  private patch(chatId: string, p: Partial<Chat>): void {
    this.store.update((s) => ({ ...s, chats: s.chats.map((c) => (c.id === chatId ? { ...c, ...p } : c)) }));
  }
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

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0];
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

function resultText(content: unknown): string {
  let s: string;
  if (typeof content === "string") s = content;
  else if (Array.isArray(content)) {
    s = content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
  } else s = content == null ? "" : JSON.stringify(content);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n… (${s.length - MAX_RESULT_CHARS} more characters)` : s;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
