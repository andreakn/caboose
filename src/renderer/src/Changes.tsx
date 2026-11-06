import { Fragment, useEffect, useMemo, useState } from "react";
import { type DiffComment, type DiffLine, type FileChange, parsePatch, type WorkspaceChanges } from "../../shared/diff.ts";
import type { Feature, FeatureRepo } from "../../shared/types.ts";

const api = window.caboose;
const MAX_LINES = 4000;

/**
 * Polls every repo's changes while the feature is open (no file watchers:
 * they behave differently on every OS).
 */
export function useFeatureChanges(ws: Feature): {
  byRepo: Record<string, WorkspaceChanges | undefined>;
  errors: Record<string, string | undefined>;
  refresh: () => void;
} {
  const [state, setState] = useState<{ byRepo: Record<string, WorkspaceChanges | undefined>; errors: Record<string, string | undefined> }>({
    byRepo: {},
    errors: {},
  });
  const [tick, setTick] = useState(0);
  const repoNames = ws.repos.map((r) => r.name).join();

  useEffect(() => {
    setState({ byRepo: {}, errors: {} });
  }, [ws.id]);

  useEffect(() => {
    if (ws.archived) return;
    let alive = true;
    const load = async () => {
      if (document.hidden) return;
      const results = await Promise.all(ws.repos.map(async (r) => [r.name, await api.changes(ws.id, r.name)] as const));
      if (!alive) return;
      setState((prev) => {
        const byRepo = { ...prev.byRepo };
        const errors: Record<string, string | undefined> = {};
        let changed = false;
        for (const [name, r] of results) {
          if (!r.ok) errors[name] = r.error;
          // Keep the old object when nothing changed, so views do not refetch.
          else if (JSON.stringify(prev.byRepo[name]) !== JSON.stringify(r.value)) {
            byRepo[name] = r.value;
            changed = true;
          }
        }
        const errorsChanged = JSON.stringify(errors) !== JSON.stringify(prev.errors);
        return changed || errorsChanged ? { byRepo, errors } : prev;
      });
    };
    void load();
    const timer = setInterval(load, 4000);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [ws.id, repoNames, ws.archived, tick]);

  return { ...state, refresh: () => setTick((t) => t + 1) };
}

export function ChangesView(props: {
  ws: Feature;
  repo: FeatureRepo;
  /** The user's comments in the whole feature not yet sent. */
  unsent: number;
  changes?: WorkspaceChanges;
  error?: string;
  comments: DiffComment[];
  refresh: () => void;
  onSendComments: () => void;
}) {
  const { ws, repo, changes, comments } = props;
  const [selected, setSelected] = useState<string | null>(null);
  const files = changes?.files ?? [];
  const file = files.find((f) => f.path === selected) ?? files[0];
  const totals = files.reduce((t, f) => ({ add: t.add + f.additions, del: t.del + f.deletions }), { add: 0, del: 0 });

  if (ws.archived) return <div className="changes-empty muted">This feature is archived.</div>;

  return (
    <div className="changes">
      <div className="changes-bar">
        <span>
          {files.length} file{files.length === 1 ? "" : "s"} changed <span className="add">+{totals.add}</span>{" "}
          <span className="del">−{totals.del}</span> <span className="muted">against</span> <code>{repo.baseRef}</code>
        </span>
        <span className="spacer" />
        <button onClick={props.refresh}>Refresh</button>
        {props.unsent > 0 && (
          <button className="primary" onClick={props.onSendComments}>
            Send {props.unsent} comment{props.unsent === 1 ? "" : "s"} to the chat
          </button>
        )}
      </div>
      {props.error && <div className="banner error">{props.error}</div>}
      {!changes && !props.error && <div className="changes-empty muted">Loading…</div>}
      {changes && files.length === 0 && <div className="changes-empty muted">No changes yet.</div>}
      {file && changes && (
        <div className="changes-body">
          <ul className="file-list">
            {files.map((f) => {
              const n = comments.filter((c) => c.file === f.path && !c.resolved).length;
              return (
                <li key={f.path}>
                  <button className={f.path === file.path ? "active" : ""} onClick={() => setSelected(f.path)} title={f.path}>
                    <span className={`status st-${f.status}`}>{STATUS_LETTER[f.status]}</span>
                    <span className="file-name">
                      {f.path.split("/").pop()}
                      <span className="file-dir">{f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}</span>
                    </span>
                    {n > 0 && <span className="comment-count">💬{n}</span>}
                    <span className="add">+{f.additions}</span>
                    <span className="del">−{f.deletions}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <FileDiff
            key={file.path}
            ws={ws}
            repo={repo.name}
            file={file}
            changes={changes}
            comments={comments.filter((c) => c.file === file.path)}
          />
        </div>
      )}
    </div>
  );
}

const STATUS_LETTER: Record<FileChange["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

function FileDiff(props: { ws: Feature; repo: string; file: FileChange; changes: WorkspaceChanges; comments: DiffComment[] }) {
  const { ws, repo, file, changes, comments } = props;
  const [patch, setPatch] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState<string | null>(null);

  // Refetch whenever the changes poll found something new.
  useEffect(() => {
    let alive = true;
    void api.filePatch(ws.id, repo, file.path).then((r) => {
      if (!alive) return;
      if (r.ok) setPatch(r.value);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [ws.id, repo, file.path, changes]);

  const hunks = useMemo(() => (patch ? parsePatch(patch) : []), [patch]);
  const lineCount = hunks.reduce((n, h) => n + h.lines.length, 0);

  const keyOf = (l: DiffLine) => (l.type === "del" ? `old:${l.old}` : `new:${l.new}`);
  const shown = new Set(hunks.flatMap((h) => h.lines.map(keyOf)));
  const commentsAt = (key: string) => comments.filter((c) => `${c.side}:${c.line}` === key);
  const outdated = comments.filter((c) => !shown.has(`${c.side}:${c.line}`));

  return (
    <div className="file-diff">
      <div className="file-head">
        {file.oldPath && <span className="muted">{file.oldPath} → </span>}
        <b>{file.path}</b>
      </div>
      {outdated.length > 0 && (
        <div className="outdated">
          <div className="muted">Comments on lines not in the diff:</div>
          {outdated.map((c) => (
            <CommentCard key={c.id} c={c} showLine />
          ))}
        </div>
      )}
      {error && <div className="banner error">{error}</div>}
      {file.binary ? (
        <div className="changes-empty muted">Binary file, not shown.</div>
      ) : patch === null ? (
        <div className="changes-empty muted">Loading…</div>
      ) : lineCount > MAX_LINES ? (
        <div className="changes-empty muted">This diff has {lineCount} lines, too many to show.</div>
      ) : (
        <table className="diff">
          <tbody>
            {hunks.map((h, hi) => (
              <Fragment key={hi}>
                <tr className="hunk">
                  <td colSpan={3}>{h.header}</td>
                </tr>
                {h.lines.map((l) => {
                  const key = keyOf(l);
                  const here = commentsAt(key);
                  return (
                    <Fragment key={`${hi}:${key}`}>
                      <tr className={`line ${l.type}`}>
                        <td className="ln">{l.old ?? ""}</td>
                        <td className="ln">
                          <button className="add-comment" title="Comment on this line" onClick={() => setComposing(key)}>
                            +
                          </button>
                          {l.new ?? ""}
                        </td>
                        <td className="code">
                          <span className="sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
                          {l.text}
                        </td>
                      </tr>
                      {(here.length > 0 || composing === key) && (
                        <tr className="comments-row">
                          <td colSpan={3}>
                            {here.map((c) => (
                              <CommentCard key={c.id} c={c} />
                            ))}
                            {composing === key && (
                              <CommentComposer
                                onCancel={() => setComposing(null)}
                                onSave={async (body) => {
                                  await api.addComment({
                                    featureId: ws.id,
                                    repo,
                                    file: file.path,
                                    side: l.type === "del" ? "old" : "new",
                                    line: (l.type === "del" ? l.old : l.new)!,
                                    lineText: l.text,
                                    body,
                                  });
                                  setComposing(null);
                                }}
                              />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CommentCard({ c, showLine }: { c: DiffComment; showLine?: boolean }) {
  return (
    <div className={`comment by-${c.author}${c.resolved ? " resolved" : ""}`}>
      <div className="comment-head">
        <b>{c.author === "claude" ? "Agent" : "You"}</b>
        {showLine && <code>line {c.line}</code>}
        <span className="muted">
          {c.resolved ? "resolved" : c.author === "user" ? (c.sentAt ? "sent to the chat" : "not sent yet") : ""}
        </span>
        <span className="spacer" />
        <button className="link" onClick={() => api.resolveComment(c.id, !c.resolved)}>
          {c.resolved ? "Reopen" : "Resolve"}
        </button>
        <button className="link" onClick={() => api.removeComment(c.id)}>
          Delete
        </button>
      </div>
      {showLine && c.lineText && <pre className="comment-line">{c.lineText}</pre>}
      <div className="comment-body">{c.body}</div>
    </div>
  );
}

function CommentComposer({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const [body, setBody] = useState("");
  return (
    <div className="comment composing">
      <textarea
        autoFocus
        rows={3}
        value={body}
        placeholder="Comment for the agent…  (Cmd/Ctrl+Enter saves)"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && body.trim()) onSave(body.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="comment-actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={!body.trim()} onClick={() => onSave(body.trim())}>
          Add comment
        </button>
      </div>
    </div>
  );
}
