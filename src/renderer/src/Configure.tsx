import { useEffect, useState } from "react";
import {
  type ConfigInfo,
  type ConfigInput,
  type DoctorCheck,
  JIRA_LEVELS,
  type JiraLevel,
  type RepoEntry,
  type Theme,
  type UpdateInfo,
} from "../../shared/types.ts";
import { applyTheme, getTheme, notificationsOn, setNotifications } from "./prefs.ts";

const api = window.caboose;

const TERMINAL_FIELDS: { key: "shellPath" | "bashPath" | "terminalFont"; label: string; hint: string }[] = [
  { key: "shellPath", label: "Terminal shell", hint: "$SHELL on macOS/Linux, PowerShell on Windows." },
  { key: "bashPath", label: "bash for scripts", hint: "On Windows: Git for Windows' bash.exe, found automatically." },
  { key: "terminalFont", label: "Terminal font", hint: "E.g. a Nerd Font your prompt needs." },
];

/** The setup screen: shown on first run, and from the Configure button. */
export function Configure({ onDone }: { onDone: () => void }) {
  const [info, setInfo] = useState<ConfigInfo | null>(null);
  const [form, setForm] = useState<ConfigInput>({});
  /** A new token typed in; undefined = keep the stored one. */
  const [token, setToken] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [notify, setNotify] = useState(notificationsOn);
  const [scan, setScan] = useState<{ folder: string; found: RepoEntry[]; picked: Set<string> } | null>(null);
  const [jiraTest, setJiraTest] = useState<string | null>(null);

  const load = () =>
    api.config().then((c) => {
      setInfo(c);
      const { jira, ...rest } = c.config;
      setForm({ ...rest, jira: jira ? { level: jira.level, site: jira.site, email: jira.email, project: jira.project } : { level: "off" } });
      setToken(undefined);
    });
  useEffect(() => void load(), []);
  if (!info) return null;

  const repos = form.repos ?? [];
  const jira = form.jira ?? { level: "off" as JiraLevel };
  const setJira = (patch: Partial<NonNullable<ConfigInput["jira"]>>) => setForm({ ...form, jira: { ...jira, ...patch } });
  const addRepos = (more: RepoEntry[]) => {
    const names = new Set(repos.map((r) => r.name));
    const paths = new Set(repos.map((r) => r.path));
    const fresh = more.filter((r) => !paths.has(r.path));
    const clash = fresh.find((r) => names.has(r.name));
    if (clash) return alert(`There is already a repo called "${clash.name}". Repo names must be unique (they are folder names in a feature).`);
    setForm({ ...form, repos: [...repos, ...fresh].sort((a, b) => a.name.localeCompare(b.name)) });
  };

  async function save(): Promise<boolean> {
    if (jira.level !== "off" && (!jira.site || !jira.email)) {
      setMessage("Jira needs a site and an email (or set Jira to Off).");
      return false;
    }
    const r = await api.saveConfig({ ...form, jira: { ...jira, ...(token !== undefined ? { token } : {}) } });
    if (!r.ok) {
      setMessage(r.error);
      return false;
    }
    setMessage("Saved.");
    await load();
    return true;
  }

  const first = info.firstRun;
  return (
    <div className="settings configure">
      <header className="ws-header">
        <div>
          <h1>{first ? "Welcome to Caboose 🚃" : "Configure"}</h1>
          <p className="muted">
            {first
              ? "Set up this machine. Everything here is saved in a file that is not in git, so each machine has its own."
              : "This machine's setup."}{" "}
            <code>{info.file}</code>
          </p>
        </div>
        {!first && <button onClick={onDone}>Close</button>}
      </header>

      <section>
        <h2>Features</h2>
        <p className="muted">
          A feature is a folder named after a railway station, with a git worktree for each repo you work on in it.
        </p>
        <div className="form">
          <label>
            <span>Features folder</span>
            <div className="row">
              <input
                value={form.featuresRoot ?? ""}
                placeholder={info.defaults.featuresRoot}
                onChange={(e) => setForm({ ...form, featuresRoot: e.target.value })}
              />
              <button
                onClick={async () => {
                  const folder = await api.pickFolder("Folder for features");
                  if (folder) setForm({ ...form, featuresRoot: folder });
                }}
              >
                Choose…
              </button>
            </div>
          </label>
          <label>
            <span>Branch prefix</span>
            <input
              value={form.branchPrefix ?? ""}
              placeholder={info.defaults.branchPrefix}
              onChange={(e) => setForm({ ...form, branchPrefix: e.target.value })}
            />
            <small className="muted">Branches are &lt;prefix&gt;/&lt;station&gt;, or &lt;prefix&gt;/&lt;JIRA-KEY&gt;-&lt;station&gt; with Jira.</small>
          </label>
        </div>
      </section>

      <section>
        <h2>Repositories</h2>
        <p className="muted">
          The repos you work on. Their name is the folder name inside a feature. For each, choose the gitignored files a new
          feature brings from the repo's main checkout (.env, *.local.* …), so the repo can run there.
        </p>
        {repos.length === 0 && <p className="del">No repositories yet.</p>}
        <ul className="repo-list">
          {repos.map((r) => (
            <RepoItem
              key={r.path}
              repo={r}
              defaults={info.defaults.localFiles}
              onChange={(next) => setForm({ ...form, repos: repos.map((x) => (x.path === r.path ? next : x)) })}
              onRemove={() => setForm({ ...form, repos: repos.filter((x) => x.path !== r.path) })}
            />
          ))}
        </ul>
        <div className="row">
          <button
            onClick={async () => {
              const folder = await api.pickFolder("Add a repository");
              if (!folder) return;
              const r = await api.checkRepo(folder);
              if (r.ok) addRepos([r.value]);
              else alert(r.error);
            }}
          >
            Add a repository…
          </button>
          <button
            onClick={async () => {
              const folder = await api.pickFolder("Find repositories in a folder (e.g. ~/code)");
              if (!folder) return;
              const found = (await api.scanRepos(folder)).filter((r) => !repos.some((x) => x.path === r.path));
              setScan({ folder, found, picked: new Set() });
            }}
          >
            Find repositories in a folder…
          </button>
        </div>
        {scan && (
          <div className="scan">
            <div className="muted">
              {scan.found.length ? `Git repositories in ${scan.folder}:` : `No new git repositories directly inside ${scan.folder}.`}
            </div>
            {scan.found.map((r) => (
              <label key={r.path} className="check">
                <input
                  type="checkbox"
                  checked={scan.picked.has(r.path)}
                  onChange={(e) => {
                    const picked = new Set(scan.picked);
                    if (e.target.checked) picked.add(r.path);
                    else picked.delete(r.path);
                    setScan({ ...scan, picked });
                  }}
                />
                {r.name}
              </label>
            ))}
            <div className="row">
              {scan.found.length > 0 && (
                <button
                  className="primary"
                  disabled={!scan.picked.size}
                  onClick={() => {
                    addRepos(scan.found.filter((r) => scan.picked.has(r.path)));
                    setScan(null);
                  }}
                >
                  Add {scan.picked.size || ""}
                </button>
              )}
              <button onClick={() => setScan(null)}>Cancel</button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Jira</h2>
        <div className="levels">
          {JIRA_LEVELS.map((l) => (
            <label key={l.value} className={`level${jira.level === l.value ? " active" : ""}`}>
              <input type="radio" name="jira-level" checked={jira.level === l.value} onChange={() => setJira({ level: l.value })} />
              <b>{l.label}</b>
              <span className="muted">{l.hint}</span>
            </label>
          ))}
        </div>
        {jira.level !== "off" && (
          <div className="form">
            <label>
              <span>Site</span>
              <input value={jira.site ?? ""} placeholder="https://yourcompany.atlassian.net" onChange={(e) => setJira({ site: e.target.value })} />
            </label>
            <label>
              <span>Email</span>
              <input value={jira.email ?? ""} placeholder="you@company.com" onChange={(e) => setJira({ email: e.target.value })} />
            </label>
            <label>
              <span>API token</span>
              <input
                type="password"
                value={token ?? ""}
                placeholder={info.config.jira?.hasToken ? "•••••••• (saved; type to replace)" : "paste an API token"}
                onChange={(e) => setToken(e.target.value)}
              />
              <small className="muted">
                Make one at id.atlassian.com → Security → API tokens.{" "}
                {info.canEncrypt
                  ? "Stored encrypted with this machine's keychain."
                  : "This machine has no keychain Caboose can use, so the token is stored in plain text in the config file."}
              </small>
            </label>
            <label>
              <span>Project for new tasks</span>
              <input value={jira.project ?? ""} placeholder="e.g. NWP" onChange={(e) => setJira({ project: e.target.value.toUpperCase() })} />
            </label>
            <div className="row">
              <button
                onClick={async () => {
                  if (!(await save())) return;
                  setJiraTest("Testing…");
                  const r = await api.jiraTest();
                  setJiraTest(r.ok ? `✓ Connected as ${r.value}` : `✗ ${r.error}`);
                }}
              >
                Save and test the connection
              </button>
              {jiraTest && <span className={jiraTest.startsWith("✓") ? "add" : jiraTest.startsWith("✗") ? "del" : "muted"}>{jiraTest}</span>}
            </div>
          </div>
        )}
      </section>

      <section>
        <h2>Terminals</h2>
        <div className="form">
          {TERMINAL_FIELDS.map((f) => (
            <label key={f.key}>
              <span>{f.label}</span>
              <input value={form[f.key] ?? ""} placeholder="default" onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              <small className="muted">{f.hint}</small>
            </label>
          ))}
        </div>
      </section>

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
          Notify me when an agent finishes or needs me while Caboose is in the background
        </label>
      </section>

      <Doctor />
      {!first && <Updates />}

      <div className="save-bar">
        <button
          className="primary"
          disabled={!repos.length}
          title={repos.length ? undefined : "Add at least one repository"}
          onClick={async () => {
            if ((await save()) && first) onDone();
          }}
        >
          {first ? "Save and start" : "Save"}
        </button>
        {message && <span className={message === "Saved." ? "muted" : "del"}>{message}</span>}
        <span className="muted">App data (features, chats): {info.dataDir}</span>
      </div>
    </div>
  );
}

/** A configured repo, with its local-file rules and a live preview of what they copy. */
function RepoItem(props: { repo: RepoEntry; defaults: string[]; onChange: (r: RepoEntry) => void; onRemove: () => void }) {
  const { repo, defaults } = props;
  const [open, setOpen] = useState(false);
  const patterns = repo.localFiles ?? defaults;
  const [text, setText] = useState(patterns.join("\n"));
  const [preview, setPreview] = useState<{ files?: string[]; notIgnored?: string[]; error?: string } | null>(null);

  // Preview the rules as they are typed (and once, for the count).
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await api.previewLocalFiles(repo.path, text.split("\n"));
      setPreview(r.ok ? { files: r.value.copy, notIgnored: r.value.notIgnored } : { error: r.error });
    }, 300);
    return () => clearTimeout(t);
  }, [text, repo.path]);

  const update = (value: string) => {
    setText(value);
    const lines = value.split("\n").map((l) => l.trim()).filter(Boolean);
    const same = lines.join("\n") === defaults.join("\n");
    props.onChange({ ...repo, localFiles: same ? undefined : lines });
  };

  return (
    <li className="repo-item">
      <div className="row">
        <b>{repo.name}</b> <code>{repo.path}</code>
        <button className="link" onClick={() => setOpen(!open)}>
          {open ? "▾" : "▸"} local files: {patterns.join(", ") || "none"}
          {preview?.files && ` (${preview.files.length} file${preview.files.length === 1 ? "" : "s"} now)`}
        </button>
        <span className="spacer" />
        <button className="link" onClick={props.onRemove}>
          Remove
        </button>
      </div>
      {open && (
        <div className="local-files">
          <div>
            <textarea rows={Math.max(3, text.split("\n").length + 1)} value={text} onChange={(e) => update(e.target.value)} spellCheck={false} />
            <small className="muted">
              One pattern per line, like .gitignore: <code>.env*</code> matches at any depth, <code>config/app.json</code> from the
              repo root, <code>certs/</code> a whole folder, <code>!pattern</code> leaves out. Only files git ignores are
              copied. <button className="link" onClick={() => update(defaults.join("\n"))}>Reset to defaults</button>
            </small>
          </div>
          <div className="local-preview">
            <div className="muted">A new feature would copy:</div>
            {preview?.error && <div className="del">{preview.error}</div>}
            {preview?.files?.length === 0 && <div className="muted">nothing</div>}
            {preview?.files?.map((f) => (
              <code key={f}>{f}</code>
            ))}
            {!!preview?.notIgnored?.length && (
              <>
                <div className="muted" title="Untracked files that git does not ignore are work in progress, not local config">
                  Matched but not gitignored, so left out:
                </div>
                {preview.notIgnored.map((f) => (
                  <code key={f} className="not-ignored">
                    {f}
                  </code>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </li>
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
      <p className="muted">Checks git, bash, the Claude Code and GitHub Copilot logins and the GitHub CLI on this machine. Uses no AI usage.</p>
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
