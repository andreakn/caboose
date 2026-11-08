// The user's to-do list (todo.md): steps only the user can do, mostly written
// by the agents with AddTodo. Open ones first, each with its details (commands
// in code blocks get a copy button); ticking one is logged for the agents, and
// "Tell …" lets the chat that asked carry on.
import { type ReactNode, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Chat } from "../../shared/chat.ts";
import type { Feature, FeatureDocs, TodoItem } from "../../shared/types.ts";
import { repoLabel } from "./labels.ts";

const api = window.caboose;

/** A code block with a copy button. */
function CopyablePre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const textOf = (n: ReactNode): string =>
    typeof n === "string" ? n : Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" && "props" in n ? textOf((n.props as { children?: ReactNode }).children) : "";
  return (
    <div className="copyable">
      <pre>{children}</pre>
      <button
        className="copy-button"
        title="Copy"
        onClick={() => {
          void navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** The chat that asked for a to-do: the repo's chat, else the feature's central one. */
function askerOf(t: TodoItem, chats: Chat[]): Chat | undefined {
  const repo = t.from && t.from !== "feature" && t.from !== "user" ? t.from : t.repo;
  const repoChat = repo ? chats.filter((c) => c.repo === repo).at(-1) : undefined;
  return repoChat ?? chats.filter((c) => !c.repo).at(-1);
}

export function TodoView({ f, docs, chats, reload, onTold }: { f: Feature; docs: FeatureDocs | null; chats: Chat[]; reload: () => void; onTold: (chat: Chat) => void }) {
  const [told, setTold] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState(false);
  if (!docs) return <div className="changes-empty muted">Loading…</div>;
  const open = docs.todos.filter((t) => !t.done);
  const done = docs.todos.filter((t) => t.done);

  const tick = async (t: TodoItem, value: boolean) => {
    const r = await api.tickTodo(f.id, t.line, value);
    if (!r.ok) alert(r.error);
    reload();
  };
  const tell = async (t: TodoItem) => {
    const chat = askerOf(t, chats);
    if (!chat) return;
    const r = await api.send(chat.id, `I have done this step from my to-do list: ${t.repo ? `[${t.repo}] ` : ""}${t.title}`);
    if (!r.ok) return alert(r.error);
    setTold(new Set(told).add(t.line));
    onTold(chat);
  };

  const item = (t: TodoItem) => {
    const asker = askerOf(t, chats);
    return (
      <li key={t.line} className={`todo${t.done ? " done" : ""}`}>
        <label className="todo-head">
          <input type="checkbox" checked={t.done} disabled={f.archived} onChange={(e) => void tick(t, e.target.checked)} />
          <span className="todo-title">{t.title}</span>
          {t.repo && <span className="chip">{repoLabel(t.repo)}</span>}
          {t.from === "user" && <span className="muted small">yours</span>}
        </label>
        {t.details && !t.done && (
          <div className="todo-details msg-text">
            <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CopyablePre }}>
              {t.details}
            </Markdown>
          </div>
        )}
        {t.done && asker && t.from !== "user" && !f.archived && (
          <div className="todo-tell">
            {told.has(t.line) ? (
              <span className="muted small">Told {asker.repo ? `${repoLabel(asker.repo)}'s chat` : "the feature chat"}.</span>
            ) : (
              <button className="link" onClick={() => void tell(t)}>
                Tell {asker.repo ? `${repoLabel(asker.repo)}'s chat` : "the feature chat"} it is done
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="todo-view">
      <div className="row">
        <span className="muted">
          {open.length ? `${open.length} step${open.length === 1 ? "" : "s"} for you to do by hand.` : docs.todos.length ? "All done." : "Nothing for you to do by hand yet."} The
          agents add steps here they cannot do themselves (migrations, secrets, settings); <code>todo.md</code> in the feature folder.
        </span>
        <span className="spacer" />
        {!f.archived && (
          <button className="link" onClick={() => setAdding(!adding)}>
            + Add a step
          </button>
        )}
      </div>
      {adding && <AddTodo f={f} onDone={() => (setAdding(false), reload())} />}
      {open.length > 0 && <ul className="todo-list">{open.map(item)}</ul>}
      {done.length > 0 && (
        <details className="todo-done" open={!open.length}>
          <summary className="muted">Done ({done.length})</summary>
          <ul className="todo-list">{done.map(item)}</ul>
        </details>
      )}
    </div>
  );
}

function AddTodo({ f, onDone }: { f: Feature; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [repo, setRepo] = useState("");
  const add = async () => {
    if (!title.trim()) return;
    const r = await api.addTodo(f.id, { title: title.trim(), ...(details.trim() ? { details: details.trim() } : {}), ...(repo ? { repo } : {}) });
    if (!r.ok) return alert(r.error);
    onDone();
  };
  return (
    <div className="todo-add">
      <div className="row">
        <input autoFocus value={title} placeholder="What to do, e.g. Ask ops for the prod database password" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
        {f.repos.length > 0 && (
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            <option value="">no repo</option>
            {f.repos.map((r) => (
              <option key={r.name} value={r.name}>
                {repoLabel(r.name)}
              </option>
            ))}
          </select>
        )}
        <button className="primary" disabled={!title.trim()} onClick={() => void add()}>
          Add
        </button>
      </div>
      <textarea rows={2} value={details} placeholder="Details (optional, markdown)" onChange={(e) => setDetails(e.target.value)} />
    </div>
  );
}
