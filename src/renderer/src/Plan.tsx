import { useCallback, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Feature, FeatureDocs, LogEntry, RepoStatus } from "../../shared/types.ts";
import { dispatch } from "./commands.ts";
import { repoLabel } from "./labels.ts";
import { stationLabel } from "../../shared/stations.ts";

const api = window.caboose;

/** The feature's files, re-read every few seconds while shown (agents write them too). */
export function useDocs(f: Feature, active = true) {
  const [docs, setDocs] = useState<FeatureDocs | null>(null);
  const load = useCallback(() => api.docs(f.id).then(setDocs), [f.id]);
  useEffect(() => {
    setDocs(null);
    void load();
  }, [f.id]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => !document.hidden && void load(), 4000);
    return () => clearInterval(t);
  }, [active, load]);
  return { docs, reload: load };
}

/** One line of markdown (bold, code, links) without a paragraph around it. */
function Inline({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={[remarkGfm]} disallowedElements={["p"]} unwrapDisallowed>
      {text}
    </Markdown>
  );
}

const firstLine = (s: string) => s.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() ?? s.split("\n")[0] ?? "";

/** Plan, brief, per-repo briefs and the log: plain files in the feature folder. */
export function PlanView({ f, docs, reload }: { f: Feature; docs: FeatureDocs | null; reload: () => void }) {
  if (!docs) return <div className="changes-empty muted">Loading…</div>;
  const { progress } = docs;
  return (
    <div className="plan-view">
      <section className="plan-section">
        <div className="plan-head">
          <h3>Plan</h3>
          {progress.total > 0 && (
            <>
              <div className="progress" title={`${progress.done} of ${progress.total} done`}>
                <div style={{ width: `${(100 * progress.done) / progress.total}%` }} />
              </div>
              <span className="muted">
                {progress.done}/{progress.total}
              </span>
            </>
          )}
          <span className="spacer" />
          <DocEditor f={f} label="plan.md" text={docs.plan} template={"# Plan\n\n- [ ] \n"} onSave={(t) => api.writeDoc(f.id, "plan", t)} onSaved={reload} />
        </div>
        {docs.tasks.length > 0 ? (
          <ul className="tasks">
            {docs.tasks.map((t) => (
              <li key={t.line} style={{ paddingLeft: t.depth * 18 }} className={t.done ? "done" : ""}>
                <label>
                  <input
                    type="checkbox"
                    checked={t.done}
                    disabled={f.archived}
                    onChange={async (e) => {
                      const r = await api.tickPlan(f.id, t.line, e.target.checked);
                      if (!r.ok) alert(r.error);
                      reload();
                    }}
                  />
                  <span className="task-text">
                    <Inline text={t.text} />
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{docs.plan ? "plan.md has no checklist items yet." : "No plan yet. Write one, or ask the central chat to."}</p>
        )}
      </section>

      <Collapsible
        title="Brief"
        summary={docs.brief ? firstLine(docs.brief).replace(/[*`_]/g, "") : "no brief yet"}
        right={<DocEditor f={f} label="brief.md" text={docs.brief} template={`# ${f.title || stationLabel(f.name)}\n\n## Goal\n\n## Scope\n\n## Out of scope\n\n## Contracts between repos\n\n## Order\n`} onSave={(t) => api.writeDoc(f.id, "brief", t)} onSaved={reload} />}
      >
        {docs.brief ? <Markdown remarkPlugins={[remarkGfm]}>{docs.brief}</Markdown> : <p className="muted">Empty.</p>}
      </Collapsible>

      <section className="plan-section">
        <h3>Repos</h3>
        {f.repos.map((r) => {
          const brief = docs.repoBriefs[r.name] ?? "";
          return (
            <Collapsible
              key={r.name}
              small
              title={repoLabel(r.name)}
              summary={brief ? firstLine(brief).replace(/[*`_]/g, "") : "no brief"}
              right={
                <>
                  {!f.archived && (
                    <button className="link" onClick={() => dispatch(`breakOut:${r.name}`)} title={`A chat working in ${r.name}/`}>
                      chat
                    </button>
                  )}
                  <DocEditor
                    f={f}
                    label={`briefs/${r.name}.md`}
                    text={brief}
                    template={`# ${r.name}\n\n## Task\n\n## Acceptance criteria\n\n- [ ] \n\n## Depends on / contracts\n`}
                    onSave={(t) => api.writeRepoBrief(f.id, r.name, t)}
                    onSaved={reload}
                  />
                </>
              }
            >
              {brief ? <Markdown remarkPlugins={[remarkGfm]}>{brief}</Markdown> : <p className="muted">Empty.</p>}
            </Collapsible>
          );
        })}
      </section>

      <LogView f={f} log={docs.log} reload={reload} />
    </div>
  );
}

function Collapsible(props: { title: string; summary: string; right?: React.ReactNode; small?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`plan-section collapsible${props.small ? " small" : ""}`}>
      <div className="plan-head" onClick={() => setOpen(!open)}>
        <span className="twisty">{open ? "▾" : "▸"}</span>
        {props.small ? <b>{props.title}</b> : <h3>{props.title}</h3>}
        {!open && <span className="muted one-line">{props.summary}</span>}
        <span className="spacer" />
        <span onClick={(e) => e.stopPropagation()} className="row">
          {props.right}
        </span>
      </div>
      {open && <div className="md">{props.children}</div>}
    </section>
  );
}

/** "edit" opens the file's markdown in place. */
function DocEditor(props: {
  f: Feature;
  label: string;
  text: string;
  template: string;
  onSave: (text: string) => Promise<{ ok: boolean; error?: string }>;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  if (props.f.archived) return null;
  if (editing === null) {
    return (
      <button className="link" onClick={() => setEditing(props.text || props.template)}>
        {props.text ? "edit" : "write"}
      </button>
    );
  }
  return (
    <div className="doc-editor" onClick={(e) => e.stopPropagation()}>
      <div className="muted">{props.label}</div>
      <textarea autoFocus rows={Math.min(24, Math.max(6, editing.split("\n").length + 1))} value={editing} onChange={(e) => setEditing(e.target.value)} spellCheck={false} />
      <div className="row">
        <span className="spacer" />
        <button onClick={() => setEditing(null)}>Cancel</button>
        <button
          className="primary"
          onClick={async () => {
            const r = await props.onSave(editing);
            if (!r.ok) return alert(r.error);
            setEditing(null);
            props.onSaved();
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

const STATUS_CLASS: Record<RepoStatus, string> = {
  queued: "muted",
  working: "pending",
  blocked: "del",
  "needs-input": "del",
  ready: "add",
  "in-review": "accent",
  done: "add",
};

export function StatusChip({ status }: { status: RepoStatus }) {
  return <span className={`status-pill ${STATUS_CLASS[status]}`}>{status}</span>;
}

/** Newest first, one line each; click to read the whole entry. Notes go to the chats they are for. */
function LogView({ f, log, reload }: { f: Feature; log: LogEntry[]; reload: () => void }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [to, setTo] = useState("all");
  const [text, setText] = useState("");
  const [shown, setShown] = useState(15);
  const entries = [...log].reverse();
  return (
    <section className="plan-section">
      <div className="plan-head">
        <h3>Log</h3>
        <span className="muted">{log.length} entr{log.length === 1 ? "y" : "ies"}</span>
      </div>
      {!f.archived && (
        <div className="note-composer">
          <select value={to} onChange={(e) => setTo(e.target.value)} title="Who it is for">
            <option value="all">to: every chat</option>
            {f.repos.map((r) => (
              <option key={r.name} value={r.name}>
                to: {repoLabel(r.name)}
              </option>
            ))}
          </select>
          <input
            value={text}
            placeholder="A note or decision: logged, and sent to the chat(s) it is for"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key !== "Enter" || !text.trim()) return;
              const r = await api.note(f.id, to, text);
              if (!r.ok) return alert(r.error);
              setText("");
              reload();
            }}
          />
        </div>
      )}
      <ul className="log-list">
        {entries.slice(0, shown).map((e, i) => {
          const isOpen = open.has(i);
          return (
            <li
              key={`${e.at}-${i}`}
              className={`log-entry${e.from === "you" ? " you" : ""}`}
              onClick={() => {
                const next = new Set(open);
                if (isOpen) next.delete(i);
                else next.add(i);
                setOpen(next);
              }}
            >
              <div className="log-line">
                <span className="muted log-time">{e.at.slice(5, 16)}</span>
                <b>{e.from}</b>
                {e.to && <span className="muted">→ {e.to}</span>}
                {e.status && <StatusChip status={e.status} />}
                {!isOpen && (
                  <span className="one-line">
                    <Inline text={firstLine(e.text)} />
                  </span>
                )}
              </div>
              {isOpen && (
                <div className="md">
                  <Markdown remarkPlugins={[remarkGfm]}>{e.text}</Markdown>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {entries.length > shown && (
        <button className="link" onClick={() => setShown(shown + 30)}>
          {entries.length - shown} older…
        </button>
      )}
    </section>
  );
}
