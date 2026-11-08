// An archived feature, read-only: its chats as they ended, its files (brief,
// plan, briefs, log) and what became of its repos. "Continue…" makes a new
// feature that carries on from it.
import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { applyEvent, closeOpen, emptyView, type LastingEvent } from "../../shared/chat.ts";
import { reposFor } from "../../shared/lines.ts";
import { stationLabel } from "../../shared/stations.ts";
import type { ArchivedFeature, ConfigView, Feature } from "../../shared/types.ts";
import { Item } from "./Chat.tsx";
import { repoLabel } from "./labels.ts";

const api = window.caboose;

export function ArchivedView({ a, config, continuedAs, onContinued }: { a: ArchivedFeature; config: ConfigView; continuedAs?: Feature; onContinued: (f: Feature) => void }) {
  // Chats that were used, named by repo or title (numbered where names repeat).
  const seen = new Map<string, number>();
  const chatTabs = a.chats
    .filter((c) => c.messages > 0)
    .map((c) => {
      const base = c.repo ? repoLabel(c.repo) : c.title && c.title !== "New chat" ? c.title : "Feature chat";
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { key: c.id, label: n > 1 ? `${base} ${n}` : base };
    });
  const tabs = [...chatTabs, { key: "files", label: "Files" }, { key: "repos", label: "Repos" }];
  const [tab, setTab] = useState(tabs[0].key);
  const [continuing, setContinuing] = useState(false);
  useEffect(() => setTab(tabs[0].key), [a.folder]);

  return (
    <div className="ws-view archived-view">
      <header className="ws-header">
        <div>
          <h1>
            {stationLabel(a.name)} <span className="status-chip st-archived">archived</span>
            {a.line && <span className="line-chip">{a.line} line</span>}
          </h1>
          <div className="muted">
            {a.title ? `${a.title} · ` : ""}
            {a.createdAt.slice(0, 10)} – {a.archivedAt.slice(0, 10)} · read-only
            {continuedAs && (
              <>
                {" "}
                · continued as <b>{stationLabel(continuedAs.name)}</b>
              </>
            )}
          </div>
        </div>
        <span className="spacer" />
        <button onClick={() => void api.openPath(a.folder)} title={a.folder}>
          Open folder
        </button>
        <button className="primary" onClick={() => setContinuing(true)} title="A new feature that carries on from this one, with its chats' history">
          Continue…
        </button>
      </header>
      <div className="scope-tabs">
        {tabs.map((t) => (
          <button key={t.key} className={tab === t.key ? "active" : ""} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="archived-body">
        {tab === "files" ? <ArchivedFiles a={a} /> : tab === "repos" ? <ArchivedRepos a={a} /> : <ArchivedChat a={a} chatId={tab} />}
      </div>
      {continuing && (
        <ContinueDialog
          a={a}
          config={config}
          onCancel={() => setContinuing(false)}
          onDone={(f) => {
            setContinuing(false);
            onContinued(f);
          }}
        />
      )}
    </div>
  );
}

function ArchivedChat({ a, chatId }: { a: ArchivedFeature; chatId: string }) {
  const [events, setEvents] = useState<LastingEvent[] | null>(null);
  useEffect(() => {
    setEvents(null);
    void api.archivedChat(a.folder, chatId).then((e) => setEvents(e as LastingEvent[]));
  }, [a.folder, chatId]);
  const view = useMemo(() => (events ? closeOpen(events).reduce(applyEvent, emptyView()) : null), [events]);
  const chat = a.chats.find((c) => c.id === chatId);
  const agent = chat?.agent === "copilot" ? "Copilot" : "Claude";
  if (!view) return <div className="muted">Loading…</div>;
  if (!view.items.length) return <div className="muted">This chat was empty.</div>;
  return (
    <div className="messages archived-messages">
      {view.items.map((item) => (
        <Item key={`${item.kind}:${item.id}`} item={item} chatId={`archived:${chatId}`} agent={agent} rel={(p) => p} />
      ))}
    </div>
  );
}

function ArchivedFiles({ a }: { a: ArchivedFeature }) {
  const [docs, setDocs] = useState<{ name: string; text: string }[] | null>(null);
  useEffect(() => void api.archivedDocs(a.folder).then(setDocs), [a.folder]);
  if (!docs) return <div className="muted">Loading…</div>;
  if (!docs.length) return <div className="muted">No brief, plan or log was written.</div>;
  return (
    <div className="archived-docs">
      {docs.map((d) => (
        <section key={d.name}>
          <h3>
            <code>{d.name}</code>
          </h3>
          <div className="msg-text">
            <Markdown remarkPlugins={[remarkGfm]}>{d.text}</Markdown>
          </div>
        </section>
      ))}
    </div>
  );
}

function ArchivedRepos({ a }: { a: ArchivedFeature }) {
  return (
    <div className="archived-repos">
      <table className="running-table">
        <thead>
          <tr>
            <th>repo</th>
            <th>branch (deleted)</th>
            <th>from</th>
          </tr>
        </thead>
        <tbody>
          {a.repos.map((r) => (
            <tr key={r.name}>
              <th>{repoLabel(r.name)}</th>
              <td>{r.branch}</td>
              <td>{r.baseRef}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {a.closedPrs.length > 0 && <p className="muted">Closed without merging when it was archived: {a.closedPrs.map((n) => `#${n}`).join(", ")}.</p>}
      <p className="muted small">
        Everything is in <code>{a.folder}</code>.
      </p>
    </div>
  );
}

/** Which repos come along (those still configured, on the line), and the title. */
function ContinueDialog({ a, config, onCancel, onDone }: { a: ArchivedFeature; config: ConfigView; onCancel: () => void; onDone: (f: Feature) => void }) {
  const available = new Set(reposFor(config.repos ?? [], a.line).map((r) => r.name));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(a.repos.map((r) => r.name).filter((n) => available.has(n))));
  const [title, setTitle] = useState(a.title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    const r = await api.continueFeature(a.folder, { repos: [...picked], ...(title.trim() ? { title: title.trim() } : {}) });
    setBusy(false);
    if (r.ok) onDone(r.value);
    else setError(r.error);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" role="dialog">
        <h2>Continue {stationLabel(a.name)}</h2>
        <p className="muted">
          A new feature with fresh branches from each repo's base (the old ones were deleted), the same line, Jira task, brief and plan. Its chats
          show the earlier conversations; the agents start new sessions and can read them in <code>history/</code>.
        </p>
        <label className="form-row">
          <span>Title</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What it is about" />
        </label>
        <div className="continue-repos">
          {a.repos.map((r) => (
            <label key={r.name} className={available.has(r.name) ? "" : "muted"} title={available.has(r.name) ? undefined : "Not configured on this machine (or not on this line)"}>
              <input
                type="checkbox"
                disabled={!available.has(r.name)}
                checked={picked.has(r.name)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.name);
                  else next.delete(r.name);
                  setPicked(next);
                }}
              />
              {repoLabel(r.name)}
            </label>
          ))}
        </div>
        {error && <div className="del">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={busy} onClick={() => void go()}>
            {busy ? "Making the feature…" : "Continue in a new feature"}
          </button>
        </div>
      </div>
    </div>
  );
}
