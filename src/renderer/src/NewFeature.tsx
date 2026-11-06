import { useEffect, useRef, useState } from "react";
import type { ConfigView, Feature, JiraIssue } from "../../shared/types.ts";

const api = window.caboose;

/**
 * Like Conductor's: one optional text box. Enter with nothing in it makes an
 * empty feature to build out; with a description, the feature's central chat
 * starts on it and proposes the repos to add.
 */
export function NewFeature({ config, onCreated, onCancel }: { config: ConfigView; onCreated: (f: Feature) => void; onCancel: () => void }) {
  const level = config.jira?.level ?? "off";
  const jiraReady = level !== "off" && Boolean(config.jira?.site && config.jira?.email && config.jira?.hasToken);
  const [text, setText] = useState("");
  const [key, setKey] = useState("");
  const [mine, setMine] = useState<JiraIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
    if (jiraReady) void api.jiraMyIssues().then((r) => r.ok && setMine(r.value));
  }, [jiraReady]);

  async function create() {
    if (busy) return;
    if (level === "required" && !key.trim()) return setError("Jira is required: give the feature a task (key or URL).");
    if (level === "expected" && !key.trim() && !confirm("Create the feature without a Jira task?")) return;
    setBusy(true);
    setError(null);
    const r = await api.createFeature({ text: text.trim() || undefined, jira: key.trim() ? { key: key.trim() } : undefined });
    setBusy(false);
    if (r.ok) onCreated(r.value);
    else setError(r.error);
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog new-feature-dialog" role="dialog">
        <h2>New feature</h2>
        <textarea
          ref={input}
          rows={Math.min(12, Math.max(4, text.split("\n").length + 1))}
          value={text}
          placeholder={"What do you want to do? (optional)\n\nLeave it empty for an empty feature you build out yourself. Describe the work, and the agent works out which repos it needs and suggests them."}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void create();
            }
            if (e.key === "Escape") onCancel();
          }}
        />
        {level !== "off" && (
          <label className="jira-line">
            <span className="muted">Jira task{level === "required" ? "" : " (optional)"}</span>
            <input list="my-issues" value={key} placeholder="key or URL, e.g. NWP-1234" onChange={(e) => setKey(e.target.value)} />
            <datalist id="my-issues">
              {mine.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.summary} · {i.status}
                </option>
              ))}
            </datalist>
          </label>
        )}
        {error && <div className="del">{error}</div>}
        <div className="row">
          <span className="muted small">Enter creates it · Shift+Enter for a new line</span>
          <span className="spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" disabled={busy} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
