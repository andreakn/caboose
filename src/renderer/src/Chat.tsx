import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  applyEvent,
  type Chat,
  type ChatItem,
  type ChatView,
  EFFORTS,
  emptyView,
  AGENTS,
  type Agent,
  type ModelOption,
  MODES,
  type Question,
} from "../../shared/chat.ts";
import type { Feature } from "../../shared/types.ts";
import { activityOf, setVisibleChat, useActivityVersion } from "./activity.ts";
import { useCommand } from "./commands.ts";
import { askText } from "./Dialog.tsx";
import { MenuButton } from "./Menu.tsx";

const api = window.caboose;

const agentOf = (chat: Chat): Agent => chat.agent ?? "claude";
export const agentName = (chat: Chat) => (agentOf(chat) === "copilot" ? "Copilot" : "Claude");

/** Each agent's models, fetched once per window (Copilot's depend on the user's plan). */
const modelCache = new Map<Agent, Promise<ModelOption[]>>();
function useModels(agent: Agent): ModelOption[] {
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    let p = modelCache.get(agent);
    if (!p) {
      p = api.models(agent).then((r) => (r.ok ? r.value : []));
      modelCache.set(agent, p);
      void p.then((list) => list.length || modelCache.delete(agent)); // retry later if it failed
    }
    void p.then(setModels);
  }, [agent]);
  return models;
}

const activeKey = (ws: Feature) => `caboose-chat-${ws.id}`;

/** The chat tab the user last had open in a feature. */
export function activeChat(ws: Feature, chats: Chat[]): Chat | undefined {
  return chats.find((c) => c.id === localStorage.getItem(activeKey(ws))) ?? chats.at(-1);
}

/** Tabs for a feature's chats, and the active chat below them. */
export function ChatArea({ ws, chats, hidden }: { ws: Feature; chats: Chat[]; hidden?: boolean }) {
  const key = activeKey(ws);
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(key));
  const active = chats.find((c) => c.id === activeId) ?? chats.at(-1);
  const creating = useRef(false);

  const select = (id: string) => {
    setActiveId(id);
    localStorage.setItem(key, id);
  };

  async function newChat(agent?: Agent) {
    if (creating.current) return;
    creating.current = true;
    const central = chats.filter((c) => !c.repo).at(-1);
    const r = await api.createChat(ws.id, agent ?? (central ? agentOf(central) : active ? agentOf(active) : undefined));
    creating.current = false;
    if (r.ok) select(r.value.id);
  }

  /** A chat of its own for one repo, in its worktree, with a task. */
  async function breakOut(repo: string) {
    const existing = chats.filter((c) => c.repo === repo).at(-1);
    if (existing) return select(existing.id);
    const task = await askText({
      title: `Break out a chat for ${repo}`,
      label: "It works in the repo's worktree and has not seen the central chat, so give it a task that stands alone.",
      value: `Do your part of the feature, as described in briefs/${repo}.md.`,
      multiline: true,
      ok: "Start",
    });
    if (!task) return;
    const r = await api.startRepoChat(ws.id, repo, task, active ? agentOf(active) : undefined);
    if (r.ok) select(r.value.id);
    else alert(r.error);
  }

  // Every live feature has at least one chat.
  useEffect(() => {
    if (!ws.archived && chats.length === 0) void newChat();
  }, [ws.id, ws.archived, chats.length]);

  // The chat on screen counts as read.
  useEffect(() => {
    setVisibleChat(hidden ? null : (active?.id ?? null));
    return () => setVisibleChat(null);
  }, [hidden, active?.id]);
  useActivityVersion();

  useCommand((c) => {
    if (c === "newChat" && !ws.archived) void newChat();
    if (c.startsWith("breakOut:")) void breakOut(c.slice("breakOut:".length));
    if ((c === "nextChat" || c === "prevChat") && active && chats.length > 1) {
      const i = chats.findIndex((x) => x.id === active.id);
      select(chats[(i + (c === "nextChat" ? 1 : -1) + chats.length) % chats.length].id);
    }
    if (c.startsWith("selectChat:")) {
      const id = c.slice("selectChat:".length);
      if (chats.some((x) => x.id === id)) select(id);
    }
    if (c === "stopClaude" && active) void api.interrupt(active.id);
  });

  return (
    <div className="chat-area" hidden={hidden}>
      <div className="tabs">
        {chats.map((c) => (
          <div key={c.id} className={`tab${c.id === active?.id ? " active" : ""}`} onClick={() => select(c.id)}>
            <TabState chatId={c.id} />
            {agentOf(c) === "copilot" && <span className="agent-chip">Copilot</span>}
            {c.repo ? (
              <span className="tab-title repo-tab" title={`Works in ${c.repo}/`}>
                ⑂ {c.title}
              </span>
            ) : (
              <span className="tab-title">{c.title}</span>
            )}
            <button
              className="tab-close"
              title="Close chat"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Close "${c.title}"? Its transcript is deleted.`)) void api.removeChat(c.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {!ws.archived && (
          <MenuButton
            className="tab-new"
            title="New chat"
            label="+"
            items={[
              ...AGENTS.map((a) => ({ label: `New ${a.label} chat (whole feature)`, onClick: () => void newChat(a.value) })),
              ...(ws.repos.length ? (["separator"] as const) : []),
              ...ws.repos.map((r) => ({
                label: chats.some((c) => c.repo === r.name) ? `${r.name}'s chat` : `Break out a chat for ${r.name}…`,
                title: `A chat working in ${r.name}/`,
                onClick: () => void breakOut(r.name),
              })),
            ]}
          />
        )}
      </div>
      {active ? <ChatPanel key={active.id} chat={active} ws={ws} /> : <div className="chat-empty muted">No chats.</div>}
    </div>
  );
}

function TabState({ chatId }: { chatId: string }) {
  const a = activityOf([chatId]);
  if (a.waiting) return <span className="dot act-waiting" title="Needs you" />;
  if (a.running) return <span className="dot act-running" title="Working" />;
  if (a.unread) return <span className="dot act-unread" title="Done" />;
  return null;
}

function ChatPanel({ chat, ws }: { chat: Chat; ws: Feature }) {
  const [view, setView] = useState<ChatView>(emptyView);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    // Events that arrive before the saved transcript are already in it; drop them.
    let loaded = false;
    const off = api.onChatEvent((id, e) => {
      if (id === chat.id && loaded) setView((v) => applyEvent(v, e));
    });
    void api.chatEvents(chat.id).then((events) => {
      loaded = true;
      setView(events.reduce(applyEvent, emptyView()));
    });
    return off;
  }, [chat.id]);

  // Follow new output while the user is at the bottom.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [view]);

  const rel = (p: string) => (p.startsWith(ws.folder) ? p.slice(ws.folder.length + 1) || "." : p);

  return (
    <div className="chat">
      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {view.items.length === 0 && !view.draft && (
          <div className="chat-hello muted">
            {agentName(chat)} works in <code>{ws.folder}</code>, with {ws.repos.map((r) => r.name).join(", ") || "no repos yet"}.
          </div>
        )}
        {view.items.map((item) => (
          <Item key={`${item.kind}:${item.id}`} item={item} chatId={chat.id} agent={agentName(chat)} rel={rel} />
        ))}
        {view.draft &&
          (view.draft.kind === "text" ? (
            <div className="msg-text">
              <Markdown remarkPlugins={[remarkGfm]}>{view.draft.text}</Markdown>
            </div>
          ) : (
            <div className="thinking live">{view.draft.text || "Thinking…"}</div>
          ))}
        {view.running && !view.draft && <div className="working">{agentName(chat)} is working…</div>}
        {view.queued.map((q, i) => (
          <div key={i} className="msg-user queued" title="Sent when the current turn ends">
            {q}
          </div>
        ))}
      </div>
      <Composer
        chat={chat}
        running={view.running}
        asking={view.items.some((i) => i.kind === "question" && !i.answered)}
        disabled={ws.archived}
      />
    </div>
  );
}

function Item(props: { item: ChatItem; chatId: string; agent: string; rel: (p: string) => string }) {
  const { item, chatId, agent, rel } = props;
  switch (item.kind) {
    case "user":
      return <div className="msg-user">{item.text}</div>;
    case "text":
      return (
        <div className="msg-text">
          <Markdown remarkPlugins={[remarkGfm]}>{item.text}</Markdown>
        </div>
      );
    case "thinking":
      return (
        <details className="thinking">
          <summary>Thinking</summary>
          {item.text}
        </details>
      );
    case "tool":
      return <ToolRow item={item} rel={rel} />;
    case "permission":
      return (
        <div className={`permission${item.answer === undefined ? " open" : ""}`}>
          <div>
            {agent} wants to use <b>{toolName(item.tool)}</b>
            {toolSummary(item.input, rel) && (
              <>
                : <code>{toolSummary(item.input, rel)}</code>
              </>
            )}
          </div>
          {item.answer === undefined ? (
            <div className="permission-actions">
              <button className="primary" onClick={() => api.answerPermission(chatId, item.id, "allow")}>
                Allow
              </button>
              <button onClick={() => api.answerPermission(chatId, item.id, "always")}>Always allow</button>
              <button className="danger" onClick={() => api.answerPermission(chatId, item.id, "deny")}>
                Deny
              </button>
            </div>
          ) : (
            <div className="muted">{item.answer ? "Allowed" : "Denied"}</div>
          )}
        </div>
      );
    case "question":
      return <QuestionCard item={item} chatId={chatId} agent={agent} />;
    case "proposal":
      return <ProposalCard item={item} chatId={chatId} agent={agent} />;
    case "result":
      return (
        <div className={`turn-end${item.ok ? "" : " failed"}`}>
          {item.ok ? "Done" : `Stopped: ${item.error ?? "error"}`} · {(item.durationMs / 1000).toFixed(1)} s
        </div>
      );
    case "error":
      return <div className="msg-error">{item.text}</div>;
  }
}

/** The agent's repo suggestions: tick, untick, add others, then add them (or none). */
function ProposalCard({ item, chatId, agent }: { item: Extract<ChatItem, { kind: "proposal" }>; chatId: string; agent: string }) {
  const [picked, setPicked] = useState<Set<string>>(() => new Set(item.repos.map((r) => r.name)));
  const [extra, setExtra] = useState<string[]>([]);
  const [all, setAll] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const chat = useChat(chatId);
  useEffect(() => {
    void api.config().then((c) => setAll((c.config.repos ?? []).map((r) => r.name)));
  }, []);

  if (item.answer) {
    const { added, declined, failed } = item.answer;
    return (
      <div className="question done">
        <div className="muted">
          {agent} suggested {item.repos.map((r) => r.name).join(", ")}.{" "}
          {added.length ? `Added ${added.join(", ")}.` : "None added."}
          {declined.length ? ` Not ${declined.join(", ")}.` : ""}
          {failed?.length ? ` Failed: ${failed.join("; ")}.` : ""}
        </div>
      </div>
    );
  }
  const suggested = item.repos.map((r) => r.name);
  const others = all.filter((n) => !suggested.includes(n) && !extra.includes(n));
  const chosen = [...suggested.filter((n) => picked.has(n)), ...extra];
  const answer = async (repos: string[]) => {
    if (!chat) return;
    setBusy(true);
    const r = await api.answerProposal(chat.featureId, chatId, item.id, repos);
    setBusy(false);
    if (!r.ok) alert(r.error);
  };
  return (
    <div className="question open proposal">
      <div className="q-title">{agent} suggests adding {item.repos.length === 1 ? "this repo" : "these repos"} to the feature:</div>
      <div className="q-options">
        {item.repos.map((r) => (
          <label key={r.name} className={`q-option proposal-repo${picked.has(r.name) ? " picked" : ""}`}>
            <span>
              <input
                type="checkbox"
                checked={picked.has(r.name)}
                onChange={(e) => {
                  const n = new Set(picked);
                  if (e.target.checked) n.add(r.name);
                  else n.delete(r.name);
                  setPicked(n);
                }}
              />{" "}
              <b>{r.name}</b>
            </span>
            <span className="muted">{r.reason}</span>
          </label>
        ))}
        {extra.map((n) => (
          <label key={n} className="q-option proposal-repo picked">
            <span>
              <input type="checkbox" checked onChange={() => setExtra(extra.filter((x) => x !== n))} /> <b>{n}</b>
            </span>
            <span className="muted">added by you</span>
          </label>
        ))}
        {others.length > 0 && (
          <select className="q-other" value="" onChange={(e) => e.target.value && setExtra([...extra, e.target.value])}>
            <option value="">+ another repo…</option>
            {others.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="permission-actions">
        <button className="primary" disabled={busy || !chosen.length} onClick={() => answer(chosen)}>
          {busy ? "Adding…" : `Add ${chosen.length ? chosen.join(", ") : "them"}`}
        </button>
        <button disabled={busy} onClick={() => answer([])}>
          None of these
        </button>
      </div>
    </div>
  );
}

/** The chat (for its feature id), from the app state. */
function useChat(chatId: string): Chat | undefined {
  const [chat, setChat] = useState<Chat>();
  useEffect(() => {
    const pick = (s: { chats: Chat[] }) => setChat(s.chats.find((c) => c.id === chatId));
    void api.getState().then(pick);
    return api.onStateChanged(pick);
  }, [chatId]);
  return chat;
}

function QuestionCard({ item, chatId, agent }: { item: Extract<ChatItem, { kind: "question" }>; chatId: string; agent: string }) {
  // question text -> chosen labels, plus free text for "Other"
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});

  const answerFor = (q: Question) => {
    const labels = picked[q.question] ?? [];
    const free = other[q.question]?.trim();
    return [...labels, ...(free ? [free] : [])].join(", ");
  };
  const complete = item.questions.every((q) => answerFor(q));

  if (item.answered) {
    return (
      <div className="question done">
        {item.answers ? (
          item.questions.map((q) => (
            <div key={q.question}>
              <span className="muted">{q.question}</span> <b>{item.answers?.[q.question] ?? "—"}</b>
            </div>
          ))
        ) : (
          <div className="muted">{agent} asked: {item.questions.map((q) => q.question).join(" / ")} (answered in the chat or dismissed)</div>
        )}
      </div>
    );
  }

  const toggle = (q: Question, label: string) =>
    setPicked((p) => {
      const cur = p[q.question] ?? [];
      const next = q.multiSelect ? (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]) : [label];
      return { ...p, [q.question]: next };
    });

  return (
    <div className="question open">
      {item.questions.map((q) => (
        <div key={q.question} className="q">
          <div className="q-title">
            <span className="chip">{q.header}</span> {q.question}
            {q.multiSelect && <span className="muted"> (pick any)</span>}
          </div>
          <div className="q-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                className={`q-option${(picked[q.question] ?? []).includes(o.label) ? " picked" : ""}`}
                onClick={() => {
                  toggle(q, o.label);
                  if (!q.multiSelect) setOther((x) => ({ ...x, [q.question]: "" }));
                }}
              >
                <b>{o.label}</b>
                {o.description && <span className="muted">{o.description}</span>}
              </button>
            ))}
            <input
              className="q-other"
              placeholder="Other…"
              value={other[q.question] ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setOther((x) => ({ ...x, [q.question]: v }));
                if (!q.multiSelect && v) setPicked((p) => ({ ...p, [q.question]: [] }));
              }}
            />
          </div>
        </div>
      ))}
      <div className="permission-actions">
        <button
          className="primary"
          disabled={!complete}
          onClick={() =>
            api.answerQuestion(chatId, item.id, Object.fromEntries(item.questions.map((q) => [q.question, answerFor(q)])))
          }
        >
          Answer
        </button>
        <button onClick={() => api.answerQuestion(chatId, item.id, null)}>Dismiss</button>
        <span className="muted">or just reply below</span>
      </div>
    </div>
  );
}

function ToolRow({ item, rel }: { item: Extract<ChatItem, { kind: "tool" }>; rel: (p: string) => string }) {
  const state = !item.result ? "running" : item.result.isError ? "failed" : "ok";
  return (
    <details className={`tool ${state}`}>
      <summary>
        <span className="tool-state" />
        <span className="tool-name">{toolName(item.name)}</span>
        <span className="tool-summary">{toolSummary(item.input, rel)}</span>
      </summary>
      <pre className="tool-io">{JSON.stringify(item.input, null, 2)}</pre>
      {item.result && <pre className="tool-io result">{item.result.content || "(no output)"}</pre>}
    </details>
  );
}

/** "mcp__caboose__GetWorkspaceDiff" → "caboose · GetWorkspaceDiff" */
export function toolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

export function toolSummary(input: unknown, rel: (p: string) => string): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") return rel(i.file_path);
  if (typeof i.path === "string" && typeof i.pattern !== "string") return rel(i.path);
  const v = i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? "";
  const s = String(v).split("\n")[0];
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

function Composer(props: { chat: Chat; running: boolean; asking: boolean; disabled: boolean }) {
  const { chat, running, disabled } = props;
  const models = useModels(agentOf(chat));
  // Copilot models list the efforts they support; the chosen one stays visible either way.
  const supported = models.find((m) => m.value === chat.model)?.efforts?.filter((e) => EFFORTS.includes(e));
  const efforts = supported?.length ? [...new Set([...supported, chat.effort])] : undefined;
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => input.current?.focus(), [chat.id]);
  useCommand((c) => {
    if (c === "focusComposer") requestAnimationFrame(() => input.current?.focus());
  });

  async function send() {
    if (!text.trim()) return;
    const r = await api.send(chat.id, text);
    if (r.ok) setText("");
    else alert(r.error);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape" && running) void api.interrupt(chat.id);
  }

  if (disabled) return <div className="composer muted">This workspace is archived. Restore it to keep chatting.</div>;

  return (
    <div className="composer">
      <textarea
        ref={input}
        value={text}
        rows={Math.min(10, Math.max(2, text.split("\n").length))}
        placeholder={
          props.asking
            ? `Answer ${agentName(chat)}'s question in your own words…`
            : running
              ? `Queue a message for when ${agentName(chat)} is done…`
              : `Ask ${agentName(chat)}…  (Enter sends, Shift+Enter for a new line)`
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="composer-bar">
        <select value={chat.model} onChange={(e) => api.configureChat(chat.id, { model: e.target.value })}>
          {(models.some((m) => m.value === chat.model) ? models : [...models, { value: chat.model, label: chat.model }]).map(
            (m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ),
          )}
        </select>
        <select
          value={chat.effort}
          title="Effort"
          onChange={(e) => api.configureChat(chat.id, { effort: e.target.value as Chat["effort"] })}
        >
          {(efforts ?? EFFORTS).map((x) => (
            <option key={x} value={x}>
              Effort: {x}
            </option>
          ))}
        </select>
        <select value={chat.mode} onChange={(e) => api.configureChat(chat.id, { mode: e.target.value as Chat["mode"] })}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="spacer" />
        {running && (
          <button className="danger" onClick={() => api.interrupt(chat.id)} title="Stop (Esc)">
            Stop
          </button>
        )}
        <button className="primary" onClick={send} disabled={!text.trim()}>
          {running && !props.asking ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
