import { useEffect, useState } from "react";
import type { DoctorCheck, LocalConfig, SettingsInfo, Theme, UpdateInfo } from "../../shared/types.ts";
import { applyTheme, getTheme, notificationsOn, setNotifications } from "./prefs.ts";

const api = window.caboose;

const FIELDS: { key: keyof LocalConfig; label: string; hint: string }[] = [
  { key: "workspacesRoot", label: "Workspaces folder", hint: "Where new worktrees go." },
  { key: "branchPrefix", label: "Branch prefix", hint: "New branches are <prefix>/<station>." },
  { key: "shellPath", label: "Terminal shell", hint: "$SHELL on macOS/Linux, PowerShell on Windows." },
  { key: "bashPath", label: "bash for scripts", hint: "On Windows: Git for Windows' bash.exe, found automatically." },
  { key: "terminalFont", label: "Terminal font", hint: "E.g. a Nerd Font your prompt needs." },
];

export function Settings({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [form, setForm] = useState<LocalConfig>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [notify, setNotify] = useState(notificationsOn);

  const load = () =>
    api.settings().then((s) => {
      setInfo(s);
      setForm(s.local);
    });
  useEffect(() => void load(), []);

  async function save() {
    const r = await api.saveSettings(form);
    setSaved(r.ok ? "Saved. New workspaces and terminals use it now." : r.error);
    void load();
  }

  return (
    <div className="settings">
      <header className="ws-header">
        <h1>Settings</h1>
        <button onClick={onClose}>Close</button>
      </header>

      <section>
        <h2>Appearance</h2>
        <div className="segmented">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <button
              key={t}
              className={theme === t ? "active" : ""}
              onClick={() => {
                setTheme(t);
                applyTheme(t);
              }}
            >
              {{ system: "Follow the system", light: "Light", dark: "Dark" }[t]}
            </button>
          ))}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={notify}
            onChange={(e) => {
              setNotify(e.target.checked);
              setNotifications(e.target.checked);
            }}
          />
          Notify me when Claude finishes or needs me while Caboose is in the background
        </label>
      </section>

      <section>
        <h2>This machine</h2>
        <p className="muted">
          Saved in <code>{info?.file}</code> (not in git). Leave a field empty for the default.
        </p>
        <div className="form">
          {FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input
                value={form[f.key] ?? ""}
                placeholder={info?.resolved[f.key] ?? "default"}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
              />
              <small className="muted">{f.hint}</small>
            </label>
          ))}
        </div>
        <div className="row">
          <button className="primary" onClick={save}>
            Save
          </button>
          {saved && <span className="muted">{saved}</span>}
        </div>
        <p className="muted">
          App data (repos, workspaces, chats): <code>{info?.dataDir}</code>
        </p>
      </section>

      <Doctor />
      <Updates />
    </div>
  );
}

function Doctor() {
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [running, setRunning] = useState(false);
  async function runChecks() {
    setRunning(true);
    setChecks(await api.doctor());
    setRunning(false);
  }
  return (
    <section>
      <h2>Prerequisites</h2>
      <p className="muted">Checks git, bash, your Claude Code login and the GitHub CLI on this machine. Uses no Claude usage.</p>
      <button onClick={runChecks} disabled={running}>
        {running ? "Checking…" : "Run checks"}
      </button>
      {checks && (
        <ul className="doctor">
          {checks.map((c) => (
            <li key={c.name}>
              <span className={c.ok ? "add" : "del"}>{c.ok ? "✓" : "✗"}</span> <b>{c.name}</b>{" "}
              <span className="muted">{c.detail}</span>
              {!c.ok && c.hint && <div className="hint">{c.hint}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Updates() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => api.onUpdateLog((line) => setLog((l) => [...l, line])), []);

  async function check() {
    setBusy("Checking…");
    const r = await api.checkForUpdate();
    setBusy(null);
    if (r.ok) {
      setInfo(r.value);
      setError(null);
    } else setError(r.error);
  }

  async function update() {
    setLog([]);
    setBusy("Updating… Caboose restarts when it is done.");
    const r = await api.update(); // only returns if it failed
    setBusy(null);
    if (!r.ok) setError(r.error);
  }

  return (
    <section>
      <h2>Updates</h2>
      <p className="muted">Caboose updates by pulling its own git checkout, then rebuilding and restarting.</p>
      <div className="row">
        <button onClick={check} disabled={!!busy}>
          Check for updates
        </button>
        {info && (
          <span className="muted">
            On <code>{info.branch}</code> at <code>{info.commit}</code>
            {info.note ? ` · ${info.note}` : info.behind ? ` · ${info.behind} new commit${info.behind === 1 ? "" : "s"}` : " · up to date"}
            {info.dirty && " · has local changes"}
          </span>
        )}
      </div>
      {info && info.behind > 0 && (
        <>
          <ul className="commits">
            {info.commits.slice(0, 15).map((c) => (
              <li key={c}>
                <code>{c.slice(0, 7)}</code> {c.slice(8)}
              </li>
            ))}
          </ul>
          <button className="primary" onClick={update} disabled={!!busy || info.dirty || info.ahead > 0}>
            Update and restart
          </button>
        </>
      )}
      {busy && <p className="muted">{busy}</p>}
      {error && <p className="del">{error}</p>}
      {log.length > 0 && <pre className="log">{log.join("\n")}</pre>}
    </section>
  );
}
