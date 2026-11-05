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
  MODELS,
  MODES,
} from "../../shared/chat.ts";
import type { Workspace } from "../../shared/types.ts";

const api = window.caboose;

/** Tabs for a workspace's chats, and the active chat below them. */
export function ChatArea({ ws, chats }: { ws: Workspace; chats: Chat[] }) {
  const key = `caboose-chat-${ws.id}`;
  const [activeId, setActiveId] = useState<string | null>(() => localStorage.getItem(key));
  const active = chats.find((c) => c.id === activeId) ?? chats.at(-1);
  const creating = useRef(false);

  const select = (id: string) => {
    setActiveId(id);
    localStorage.setItem(key, id);
  };

  async function newChat() {
    if (creating.current) return;
    creating.current = true;
    const r = await api.createChat(ws.id);
    creating.current = false;
    if (r.ok) select(r.value.id);
  }

  // Every live workspace has at least one chat.
  useEffect(() => {
    if (!ws.archived && chats.length === 0) void newChat();
  }, [ws.id, ws.archived, chats.length]);

  return (
    <div className="chat-area">
      <div className="tabs">
        {chats.map((c) => (
          <div key={c.id} className={`tab${c.id === active?.id ? " active" : ""}`} onClick={() => select(c.id)}>
            <span className="tab-title">{c.title}</span>
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
          <button className="tab-new" title="New chat" onClick={newChat}>
            +
          </button>
        )}
      </div>
      {active ? <ChatPanel key={active.id} chat={active} ws={ws} /> : <div className="chat-empty muted">No chats.</div>}
    </div>
  );
}

function ChatPanel({ chat, ws }: { chat: Chat; ws: Workspace }) {
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

  const rel = (p: string) => (p.startsWith(ws.path) ? p.slice(ws.path.length + 1) || "." : p);

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
            Claude works in <code>{ws.path}</code> on <code>{ws.branch}</code>.
          </div>
        )}
        {view.items.map((item) => (
          <Item key={`${item.kind}:${item.id}`} item={item} chatId={chat.id} rel={rel} />
        ))}
        {view.draft &&
          (view.draft.kind === "text" ? (
            <div className="msg-text">
              <Markdown remarkPlugins={[remarkGfm]}>{view.draft.text}</Markdown>
            </div>
          ) : (
            <div className="thinking live">{view.draft.text || "Thinking…"}</div>
          ))}
        {view.running && !view.draft && <div className="working">Claude is working…</div>}
        {view.queued.map((q, i) => (
          <div key={i} className="msg-user queued" title="Sent when the current turn ends">
            {q}
          </div>
        ))}
      </div>
      <Composer chat={chat} running={view.running} disabled={ws.archived} />
    </div>
  );
}

function Item({ item, chatId, rel }: { item: ChatItem; chatId: string; rel: (p: string) => string }) {
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
            Claude wants to use <b>{item.tool}</b>
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

function ToolRow({ item, rel }: { item: Extract<ChatItem, { kind: "tool" }>; rel: (p: string) => string }) {
  const state = !item.result ? "running" : item.result.isError ? "failed" : "ok";
  return (
    <details className={`tool ${state}`}>
      <summary>
        <span className="tool-state" />
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{toolSummary(item.input, rel)}</span>
      </summary>
      <pre className="tool-io">{JSON.stringify(item.input, null, 2)}</pre>
      {item.result && <pre className="tool-io result">{item.result.content || "(no output)"}</pre>}
    </details>
  );
}

function toolSummary(input: unknown, rel: (p: string) => string): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === "string") return rel(i.file_path);
  if (typeof i.path === "string" && typeof i.pattern !== "string") return rel(i.path);
  const v = i.command ?? i.pattern ?? i.url ?? i.query ?? i.description ?? i.prompt ?? "";
  const s = String(v).split("\n")[0];
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

function Composer({ chat, running, disabled }: { chat: Chat; running: boolean; disabled: boolean }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => input.current?.focus(), [chat.id]);

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
        placeholder={running ? "Queue a message for when Claude is done…" : "Ask Claude…  (Enter sends, Shift+Enter for a new line)"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="composer-bar">
        <select value={chat.model} onChange={(e) => api.configureChat(chat.id, { model: e.target.value as Chat["model"] })}>
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={chat.effort}
          title="Effort"
          onChange={(e) => api.configureChat(chat.id, { effort: e.target.value as Chat["effort"] })}
        >
          {EFFORTS.map((x) => (
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
          {running ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
