import { useEffect, useState } from "react";
import type { ConfigView, Feature, JiraIssue } from "../../shared/types.ts";

const api = window.caboose;

/** Picks repos and (depending on the Jira level) a Jira task for a new feature. */
export function NewFeature({ config, onCreated, onCancel }: { config: ConfigView; onCreated: (f: Feature) => void; onCancel: () => void }) {
  const repos = config.repos ?? [];
  const level = config.jira?.level ?? "off";
  const jiraReady = level !== "off" && Boolean(config.jira?.site && config.jira?.email && config.jira?.hasToken);
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(repos.length === 1 ? [repos[0].name] : []));
  const [mode, setMode] = useState<"none" | "key" | "create">(level === "required" || level === "expected" ? "key" : "none");
  const [key, setKey] = useState("");
  const [summary, setSummary] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [mine, setMine] = useState<JiraIssue[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (jiraReady) void api.jiraMyIssues().then((r) => setMine(r.ok ? r.value : []));
  }, [jiraReady]);

  // Show what a typed key points at.
  useEffect(() => {
    setPreview(null);
    if (!jiraReady || mode !== "key" || !/[A-Za-z][A-Za-z0-9_]+-\d+/.test(key)) return;
    const t = setTimeout(async () => {
      const r = await api.jiraIssue(key.match(/[A-Za-z][A-Za-z0-9_]+-\d+/)![0].toUpperCase());
      setPreview(r.ok ? `${r.value.key}: ${r.value.summary} (${r.value.status})` : r.error);
    }, 400);
    return () => clearTimeout(t);
  }, [key, mode, jiraReady]);

  const jiraInput = mode === "key" && key.trim() ? { key: key.trim() } : mode === "create" && summary.trim() ? { create: summary.trim() } : undefined;
  const missingJira = level === "required" && !jiraInput;

  async function create() {
    setError(null);
    if (level === "expected" && !jiraInput && !confirm("Create the feature without a Jira task?")) return;
    setBusy(`Creating the feature${level === "required" ? " and Jira subtasks" : ""}…`);
    const r = await api.createFeature({ repos: [...picked], jira: jiraInput, title });
    setBusy(null);
    if (r.ok) onCreated(r.value);
    else setError(r.error);
  }

  return (
    <div className="settings new-feature">
      <header className="ws-header">
        <div>
          <h1>New feature</h1>
          <p className="muted">It gets a station name and a folder, with a worktree on a fresh branch for each repo you pick.</p>
        </div>
        <button onClick={onCancel}>Cancel</button>
      </header>

      <section>
        <div className="form">
          <label>
            <span>Title</span>
            <input autoFocus value={title} placeholder="What is it about? (optional)" onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
      </section>

      <section>
        <h2>Repositories</h2>
        {repos.length === 0 && <p className="del">No repositories configured. Add some in Configure.</p>}
        <div className="repo-picks">
          {repos.map((r) => (
            <label key={r.name} className={`level${picked.has(r.name) ? " active" : ""}`}>
              <input
                type="checkbox"
                checked={picked.has(r.name)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(r.name);
                  else next.delete(r.name);
                  setPicked(next);
                }}
              />
              <b>{r.name}</b>
              <code className="muted">{r.path}</code>
            </label>
          ))}
        </div>
        <p className="muted">You can add more repos to the feature later.</p>
      </section>

      {level !== "off" && (
        <section>
          <h2>Jira task {level === "required" ? "(required)" : level === "expected" ? "(expected)" : "(optional)"}</h2>
          {!jiraReady && (
            <p className="muted">
              Jira is not connected (Configure → Jira). You can still type a key; Caboose cannot check it or create subtasks.
            </p>
          )}
          <div className="segmented">
            {level !== "required" && (
              <button className={mode === "none" ? "active" : ""} onClick={() => setMode("none")}>
                No task
              </button>
            )}
            <button className={mode === "key" ? "active" : ""} onClick={() => setMode("key")}>
              Existing task
            </button>
            {jiraReady && config.jira?.project && (
              <button className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>
                New task in {config.jira.project}
              </button>
            )}
          </div>
          {mode === "key" && (
            <div className="form">
              <label>
                <span>Key or URL</span>
                <input autoFocus value={key} placeholder="e.g. NWP-1234" onChange={(e) => setKey(e.target.value)} />
                {preview && <small className="muted">{preview}</small>}
              </label>
              {mine && mine.length > 0 && (
                <div className="my-issues">
                  <div className="muted">Your open issues:</div>
                  {mine.slice(0, 12).map((i) => (
                    <button key={i.key} className={`issue${key === i.key ? " active" : ""}`} onClick={() => setKey(i.key)}>
                      <b>{i.key}</b> {i.summary} <span className="muted">· {i.status}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {mode === "create" && (
            <div className="form">
              <label>
                <span>Summary</span>
                <input autoFocus value={summary} placeholder="What the feature is about" onChange={(e) => setSummary(e.target.value)} />
              </label>
            </div>
          )}
          <p className="muted">Each repo gets a subtask under the task (created when Jira is connected), and its key goes in that repo's branch name.</p>
        </section>
      )}

      <div className="save-bar">
        <button className="primary" disabled={!picked.size || missingJira || !!busy} onClick={create}>
          Create feature
        </button>
        {busy && <span className="muted">{busy}</span>}
        {error && <span className="del">{error}</span>}
      </div>
    </div>
  );
}
