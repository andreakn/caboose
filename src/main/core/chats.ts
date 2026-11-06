// Chats: one agent session per chat tab (Claude Code or GitHub Copilot).
// This engine owns the transcript, the queue, approvals and questions; the
// agent adapters in ./agents translate their SDKs. Electron-free.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Agent, applyEvent, type Chat, type ChatEvent, type Effort, emptyView, type LastingEvent, type Mode, type Model, type ModelOption } from "../../shared/chat.ts";
import type { Result } from "../../shared/types.ts";
import type { AgentHost, AgentProvider, AgentSession, PermissionAnswer, QuestionAnswer } from "./agents/types.ts";
import type { Store } from "./store.ts";

type Live = {
  session: AgentSession;
  running: boolean;
  queue: string[];
  draft?: { kind: "text" | "thinking"; text: string };
  /** Open approval and question cards, by event id. */
  permissions: Map<string, (a: PermissionAnswer) => void>;
  questions: Map<string, (a: QuestionAnswer) => void>;
};

const DEFAULTS = { model: "default", effort: "high" as Effort, mode: "acceptEdits" as Mode };

export const agentOf = (chat: Chat): Agent => chat.agent ?? "claude";

export class Chats {
  private store: Store;
  private dir: string;
  private providers: Record<Agent, AgentProvider>;
  private emit: (chatId: string, e: ChatEvent) => void;
  private live = new Map<string, Live>();

  constructor(
    store: Store,
    dataDir: string,
    providers: Partial<Record<Agent, AgentProvider>>,
    emit: (chatId: string, e: ChatEvent) => void,
  ) {
    this.store = store;
    this.dir = join(dataDir, "chats");
    this.providers = providers as Record<Agent, AgentProvider>;
    this.emit = emit;
  }

  /** A new chat (in a repo's worktree, or the feature's central chat); settings come from the feature's latest chat with the same agent. */
  create(featureId: string, agent?: Agent, repo?: string): Result<Chat> {
    const feature = this.store.get().features.find((f) => f.id === featureId);
    if (!feature) return { ok: false, error: "Unknown feature." };
    if (repo && !feature.repos.some((r) => r.name === repo)) return { ok: false, error: `No repo "${repo}" in this feature.` };
    const inWs = this.store.get().chats.filter((c) => c.featureId === featureId);
    const kind = agent ?? (inWs.length ? agentOf(inWs.at(-1)!) : "claude");
    if (!this.providers[kind]) return { ok: false, error: `${kind} is not available.` };
    const last = inWs.filter((c) => agentOf(c) === kind).at(-1) ?? this.store.get().chats.filter((c) => agentOf(c) === kind).at(-1);
    const chat: Chat = {
      id: randomUUID(),
      featureId,
      agent: kind,
      ...(repo ? { repo } : {}),
      title: repo ? repo : "New chat",
      model: last?.model ?? DEFAULTS.model,
      effort: last?.effort ?? DEFAULTS.effort,
      mode: last?.mode ?? DEFAULTS.mode,
      createdAt: new Date().toISOString(),
    };
    this.store.update((s) => ({ ...s, chats: [...s.chats, chat] }));
    return { ok: true, value: chat };
  }

  /** Shows the agent's repo suggestions as a card in the chat. */
  propose(chatId: string, repos: { name: string; reason: string }[]): string {
    const id = randomUUID();
    this.record(chatId, { t: "proposal", id, repos });
    return id;
  }

  /** The proposal card's answer; null if it is unknown or already answered. */
  openProposal(chatId: string, id: string): { name: string; reason: string }[] | null {
    const view = this.events(chatId).reduce(applyEvent, emptyView());
    const p = view.items.find((i) => i.kind === "proposal" && i.id === id);
    return p && p.kind === "proposal" && !p.answer ? p.repos : null;
  }

  settleProposal(chatId: string, id: string, answer: { added: string[]; declined: string[]; failed?: string[] }): void {
    this.record(chatId, { t: "proposal_answer", id, ...answer });
  }

  /** The feature's most recent chat for a repo (or its central chat, without one). */
  latest(featureId: string, repo?: string): Chat | undefined {
    return this.store
      .get()
      .chats.filter((c) => c.featureId === featureId && (c.repo ?? undefined) === (repo ?? undefined))
      .at(-1);
  }

  /** What a chat is doing, from its transcript and live state. */
  state(chatId: string): { running: boolean; waiting: boolean; lastText?: string; lastAt?: string; turns: number } {
    const view = this.events(chatId).reduce(applyEvent, emptyView());
    const texts = view.items.filter((i) => i.kind === "text");
    const users = view.items.filter((i) => i.kind === "user");
    return {
      running: view.running,
      waiting: view.items.some((i) => (i.kind === "permission" && i.answer === undefined) || (i.kind === "question" && !i.answered)),
      lastText: texts.at(-1)?.kind === "text" ? (texts.at(-1) as { text: string }).text : undefined,
      turns: users.length,
    };
  }

  models(agent: Agent): Promise<ModelOption[]> {
    return this.providers[agent]?.models() ?? Promise.resolve([]);
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
    const [questionId, answer] = [...live.questions][0] ?? [];
    if (questionId && answer) {
      // Replying in the chat while the agent asks something answers it in words.
      this.record(chatId, { t: "user", id: randomUUID(), text, at: new Date().toISOString() });
      this.settleQuestion(chatId, live, questionId, null);
      answer({ repliedInChat: text });
    } else if (live.running) {
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
    this.denyAll(chatId, live);
    this.status(chatId, live);
    await live.session.interrupt().catch(() => {});
  }

  answerPermission(chatId: string, id: string, answer: PermissionAnswer): void {
    const live = this.live.get(chatId);
    const resolve = live?.permissions.get(id);
    if (!live || !resolve) return;
    live.permissions.delete(id);
    this.record(chatId, { t: "permission_answer", id, allowed: answer !== "deny" });
    resolve(answer);
  }

  answerQuestion(chatId: string, id: string, answers: Record<string, string> | null): void {
    const live = this.live.get(chatId);
    const resolve = live?.questions.get(id);
    if (!live || !resolve) return;
    this.settleQuestion(chatId, live, id, answers);
    resolve(answers);
  }

  async configure(chatId: string, patch: { model?: Model; effort?: Effort; mode?: Mode }): Promise<void> {
    if (!this.chat(chatId)) return;
    this.patch(chatId, patch);
    await this.live
      .get(chatId)
      ?.session.configure(patch)
      .catch(() => {});
  }

  /** Closes the tab: ends its session and forgets the transcript. */
  remove(chatId: string): void {
    this.stop(chatId);
    this.store.update((s) => ({ ...s, chats: s.chats.filter((c) => c.id !== chatId) }));
    rmSync(this.file(chatId), { force: true });
  }

  /** Ends every session in a feature (it is being archived). Transcripts stay. */
  stopFeature(featureId: string): void {
    for (const c of this.store.get().chats) if (c.featureId === featureId) this.stop(c.id);
  }

  stopAll(): void {
    for (const id of [...this.live.keys()]) this.stop(id);
  }

  private stop(chatId: string): void {
    const live = this.live.get(chatId);
    if (!live) return;
    this.live.delete(chatId);
    this.denyAll(chatId, live);
    try {
      live.session.close();
    } catch {
      // already gone
    }
  }

  private start(chat: Chat): Result<Live> {
    const feature = this.store.get().features.find((f) => f.id === chat.featureId);
    if (!feature || feature.archived) return { ok: false, error: "This feature is archived." };
    const provider = this.providers[agentOf(chat)];
    if (!provider) return { ok: false, error: `${agentOf(chat)} is not available.` };
    const live: Live = {
      session: undefined as unknown as AgentSession,
      running: false,
      queue: [],
      permissions: new Map(),
      questions: new Map(),
    };
    this.live.set(chat.id, live);
    try {
      live.session = provider.start(chat, feature, this.host(chat.id, live));
    } catch (e) {
      this.live.delete(chat.id);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    return { ok: true, value: live };
  }

  /** The callbacks one live session reports through. Ignored once the session is replaced. */
  private host(chatId: string, live: Live): AgentHost {
    const current = () => this.live.get(chatId) === live;
    return {
      sessionId: (id) => {
        if (current() && this.chat(chatId)?.sessionId !== id) this.patch(chatId, { sessionId: id });
      },
      draft: (kind, text) => {
        if (!current()) return;
        live.draft = { kind, text };
        this.emit(chatId, { t: "draft", kind, text });
      },
      text: (id, text) => this.block(chatId, live, { t: "text", id, text }),
      thinking: (id, text) => this.block(chatId, live, { t: "thinking", id, text }),
      tool: (id, name, input) => this.block(chatId, live, { t: "tool", id, name, input }),
      toolResult: (id, content, isError) => {
        if (current()) this.record(chatId, { t: "tool_result", id, content, isError });
      },
      turnEnd: ({ ok, durationMs, turns, error }) => {
        if (!current()) return;
        live.draft = undefined;
        this.record(chatId, { t: "result", id: randomUUID(), ok, durationMs, turns, ...(error ? { error } : {}) });
        live.running = false;
        const next = live.queue.shift();
        const chat = this.chat(chatId);
        if (next !== undefined && chat) this.deliver(chat, live, next);
        else this.status(chatId, live);
      },
      ended: (error) => {
        if (!current()) return;
        if (error) this.record(chatId, { t: "error", id: randomUUID(), text: error });
        this.live.delete(chatId);
        this.denyAll(chatId, live);
        if (live.draft) this.emit(chatId, { t: "draft_clear" });
        this.emit(chatId, { t: "status", running: false, queued: [] });
      },
      askPermission: (tool, input, signal) => {
        if (!current()) return Promise.resolve("deny");
        const id = randomUUID();
        return new Promise((resolve) => {
          live.permissions.set(id, resolve);
          this.record(chatId, { t: "permission", id, tool, input });
          signal?.addEventListener("abort", () => {
            if (live.permissions.delete(id)) {
              this.record(chatId, { t: "permission_answer", id, allowed: false });
              resolve("deny");
            }
          });
        });
      },
      askQuestions: (questions, signal) => {
        if (!current()) return Promise.resolve(null);
        const id = randomUUID();
        return new Promise((resolve) => {
          live.questions.set(id, resolve);
          this.record(chatId, { t: "question", id, questions });
          signal?.addEventListener("abort", () => {
            if (live.questions.has(id)) {
              this.settleQuestion(chatId, live, id, null);
              resolve(null);
            }
          });
        });
      },
    };
  }

  /** A finished block of output replaces the streaming draft. */
  private block(chatId: string, live: Live, e: LastingEvent): void {
    if (this.live.get(chatId) !== live) return;
    if (live.draft) {
      live.draft = undefined;
      this.emit(chatId, { t: "draft_clear" });
    }
    this.record(chatId, e);
  }

  private deliver(chat: Chat, live: Live, text: string): void {
    if (chat.title === "New chat") this.patch(chat.id, { title: titleFrom(text) });
    this.record(chat.id, { t: "user", id: randomUUID(), text, at: new Date().toISOString() });
    live.running = true;
    this.status(chat.id, live);
    live.session.send(text);
  }

  private settleQuestion(chatId: string, live: Live, id: string, answers: Record<string, string> | null): void {
    live.questions.delete(id);
    this.record(chatId, { t: "question_answer", id, answers });
  }

  /** Answers every open card with "no" (the turn was stopped or the session ended). */
  private denyAll(chatId: string, live: Live): void {
    for (const [id, resolve] of live.permissions) {
      this.record(chatId, { t: "permission_answer", id, allowed: false });
      resolve("deny");
    }
    live.permissions.clear();
    for (const [id, resolve] of [...live.questions]) {
      this.settleQuestion(chatId, live, id, null);
      resolve(null);
    }
  }

  private status(chatId: string, live: Live): void {
    this.emit(chatId, { t: "status", running: live.running, queued: [...live.queue] });
  }

  /** Saves a lasting event (stamped with the time, for the activity feed) and sends it to the window. */
  private record(chatId: string, e: LastingEvent): void {
    const stamped = { ...e, at: (e as { at?: string }).at ?? new Date().toISOString() } as LastingEvent;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file(chatId), `${JSON.stringify(stamped)}\n`);
    this.emit(chatId, stamped);
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

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0];
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}
