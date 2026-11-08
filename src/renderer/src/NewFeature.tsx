import { useEffect, useRef, useState } from "react";
import { AGENTS, type Agent } from "../../shared/chat.ts";
import { lineConfig, linesOf } from "../../shared/lines.ts";
import type { ConfigView, Feature, JiraIssue } from "../../shared/types.ts";

const api = window.caboose;
const LAST_LINE = "caboose-new-feature-line";

/**
 * Like Conductor's: one optional text box. Enter with nothing in it makes an
 * empty feature to build out; with a description, the feature's central chat
 * starts on it and proposes the repos to add.
 */
export function NewFeature({ config, onCreated, onCancel }: { config: ConfigView; onCreated: (f: Feature) => void; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [agent, setAgent] = useState<Agent>(config.defaultAgent ?? "claude");
  // Lines appear here once a repo is on one; the last one used is picked again.
  const lines = linesOf(config.repos ?? []);
  const [line, setLine] = useState(() => {
    const last = localStorage.getItem(LAST_LINE) ?? "";
    return lines.includes(last) ? last : "";
  });
  // The chosen line's Jira (its own, or the general one).
  const jira = lineConfig(config, line || undefined).jira;
  const level = jira?.level ?? "off";
  const jiraReady = level !== "off" && Boolean(jira?.site && jira?.email && jira?.hasToken);
  const [key, setKey] = useState("");
  const [mine, setMine] = useState<JiraIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    setMine([]);
    if (jiraReady) void api.jiraMyIssues(line || undefined).then((r) => r.ok && setMine(r.value));
  }, [jiraReady, line]);

  async function create() {
    if (busy) return;
    if (level === "required" && !key.trim()) return setError("Jira is required: give the feature a task (key or URL).");
    if (level === "expected" && !key.trim() && !confirm("Create the feature without a Jira task?")) return;
    setBusy(true);
    setError(null);
    localStorage.setItem(LAST_LINE, line);
    const r = await api.createFeature({ text: text.trim() || undefined, jira: key.trim() ? { key: key.trim() } : undefined, agent, ...(line ? { line } : {}) });
    setBusy(false);
    if (r.ok) onCreated(r.value);
    else setError(r.error);
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog new-feature-dialog" role="dialog">
        <div className="row">
          <h2>New feature</h2>
          <span className="spacer" />
          <div className="segmented small" title="Which agent the feature's chat uses">
            {AGENTS.map((a) => (
              <button key={a.value} className={agent === a.value ? "active" : ""} onClick={() => setAgent(a.value)}>
                {a.label}
              </button>
            ))}
          </div>
        </div>
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
        {lines.length > 0 && (
          <div className="line-picker">
            <span className="muted">Line</span>
            <div className="segmented small" title="Which repos the feature can have: those on this line, and those on no line">
              {["", ...lines].map((l) => (
                <button key={l || "any"} className={line === l ? "active" : ""} onClick={() => setLine(l)}>
                  {l || "Any"}
                </button>
              ))}
            </div>
            {!line && <span className="muted small">takes the line of the first repo on one</span>}
          </div>
        )}
        {level !== "off" && (
          <label className="jira-line">
            <span className="muted">Jira task{level === "required" ? "" : " (optional)"}</span>
            <input list="my-issues" value={key} placeholder="key or URL, e.g. ABC-1234" onChange={(e) => setKey(e.target.value)} />
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
