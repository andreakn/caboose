import { useEffect, useState } from "react";
import {
  type ConfigInfo,
  type ConfigInput,
  type DoctorCheck,
  JIRA_LEVELS,
  type JiraLevel,
  type AgentLogins,
  type ConductorImport,
  type RepoEntry,
  type RepoScripts,
  type Theme,
  type UpdateInfo,
} from "../../shared/types.ts";
import { MODES } from "../../shared/chat.ts";
import { useApps } from "./Menu.tsx";
import { applyTheme, getTheme, notificationsOn, setNotifications } from "./prefs.ts";

const api = window.caboose;

const TERMINAL_FIELDS: { key: "shellPath" | "bashPath" | "terminalFont" | "monikersFile"; label: string; hint: string }[] = [
  { key: "shellPath", label: "Terminal shell", hint: "$SHELL on macOS/Linux, PowerShell on Windows." },
  { key: "bashPath", label: "bash for scripts", hint: "On Windows: Git for Windows' bash.exe, found automatically." },
  { key: "terminalFont", label: "Terminal font", hint: "E.g. a Nerd Font your prompt needs." },
  {
    key: "monikersFile",
    label: "Moniker file",
    hint: "Optional, e.g. ~/home/varner/monikers.txt: \"moniker path description\" per line. Names repos and describes their run_<moniker>.sh in the Run tab.",
  },
];

/** The setup screen: shown on first run, and from the Configure button. */
export function Configure({ onDone, onSaved }: { onDone: () => void; onSaved?: () => void }) {
  const [info, setInfo] = useState<ConfigInfo | null>(null);
  const [form, setForm] = useState<ConfigInput>({});
  /** A new token typed in; undefined = keep the stored one. */
  const [token, setToken] = useState<string | undefined>(undefined);
  const [message, setMessage] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(getTheme);
  const [notify, setNotify] = useState(notificationsOn);
  const [scan, setScan] = useState<{ folder: string; found: RepoEntry[]; picked: Set<string> } | null>(null);
  const [jiraTest, setJiraTest] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [logins, setLogins] = useState<AgentLogins | null>(null);
  useEffect(() => {
    void api.agentLogins().then(setLogins);
  }, []);
  // First run: preselect the agent that is logged in (Claude if both or neither).
  useEffect(() => {
    if (!logins || !info?.firstRun || form.defaultAgent) return;
    setForm((f) => ({ ...f, defaultAgent: !logins.claude.ok && logins.copilot.ok ? "copilot" : "claude" }));
  }, [logins, info?.firstRun]);
  const apps = useApps();

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
    setForm((f) => ({ ...f, repos: [...(f.repos ?? []), ...fresh].sort((a, b) => a.name.localeCompare(b.name)) }));
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
    onSaved?.();
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
        <h2>Main agent</h2>
        <p className="muted">Which agent new chats use. You can still pick the other one per chat (the "+" on the chat tabs).</p>
        <div className="levels">
          {(
            [
              ["claude", "Claude Code", "With a Claude subscription or API key."],
              ["copilot", "GitHub Copilot", "With a Copilot plan, through your GitHub login (gh auth login)."],
            ] as const
          ).map(([id, label, hint]) => {
            const l = logins?.[id];
            return (
              <label key={id} className={`level${(form.defaultAgent ?? "claude") === id ? " active" : ""}`}>
                <input type="radio" name="main-agent" checked={(form.defaultAgent ?? "claude") === id} onChange={() => setForm({ ...form, defaultAgent: id })} />
                <b>{label}</b>
                <span className="muted">
                  {!l ? "checking the login…" : l.ok ? <span className="add">✓ {l.detail}</span> : <span className="del">✗ not logged in</span>} · {hint}
                </span>
              </label>
            );
          })}
        </div>
      </section>

      <section>
        <h2>Permissions for new chats</h2>
        <p className="muted">What the agent may do without asking. Each chat can change it in the picker under its message box.</p>
        <div className="levels">
          {MODES.map((m) => (
            <label key={m.value} className={`level${(form.defaultMode ?? "bypassPermissions") === m.value ? " active" : ""}`}>
              <input
                type="radio"
                name="default-mode"
                checked={(form.defaultMode ?? "bypassPermissions") === m.value}
                onChange={() => setForm({ ...form, defaultMode: m.value })}
              />
              <b>{m.label}</b>
              <span className="muted">{m.hint}</span>
            </label>
          ))}
        </div>
      </section>

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
            <span>Archive folder</span>
            <div className="row">
              <input
                value={form.archiveRoot ?? ""}
                placeholder={info.defaults.archiveRoot}
                onChange={(e) => setForm({ ...form, archiveRoot: e.target.value })}
              />
              <button
                onClick={async () => {
                  const folder = await api.pickFolder("Folder for archived features");
                  if (folder) setForm({ ...form, archiveRoot: folder });
                }}
              >
                Choose…
              </button>
            </div>
            <small className="muted">Archiving a feature moves its folder and chat logs here, as yyyy-mm-dd_hh-mm_&lt;station&gt;.</small>
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
              if (!r.ok) return alert(r.error);
              // Rules the repo already declares for Conductor (.worktreeinclude, .conductor/*.toml)
              const rules = await api.repoRules(r.value.path);
              addRepos([{ ...r.value, ...(rules ? { localFiles: rules.patterns } : {}) }]);
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
          <button onClick={() => setImporting(!importing)}>Import from Conductor…</button>
        </div>
        {importing && (
          <ImportFromConductor
            onCancel={() => setImporting(false)}
            onImport={(picked, prInstructions) => {
              addRepos(picked);
              if (prInstructions) setForm((f) => ({ ...f, prInstructions }));
              setImporting(false);
            }}
          />
        )}
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
                  onClick={async () => {
                    const picked = scan.found.filter((r) => scan.picked.has(r.path));
                    const withRules = await Promise.all(
                      picked.map(async (r) => {
                        const rules = await api.repoRules(r.path);
                        return rules ? { ...r, localFiles: rules.patterns } : r;
                      }),
                    );
                    addRepos(withRules);
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
        <h2>Pull requests</h2>
        <p className="muted">How you want PRs written. Added to every "Create PR" request to the agent.</p>
        <textarea
          className="wide"
          rows={Math.min(14, Math.max(4, (form.prInstructions ?? "").split("\n").length + 1))}
          value={form.prInstructions ?? ""}
          placeholder="e.g. Imperative title. Open with what changed and why. State build and test status."
          onChange={(e) => setForm({ ...form, prInstructions: e.target.value })}
        />
      </section>

      <section>
        <h2>Open in</h2>
        <p className="muted">
          Found on this machine: {apps.map((a) => a.label).join(", ") || "nothing yet"}. To use another app or path, add{" "}
          <code>"openWith": {"{"} "rider": "/path/to/rider {"{path}"}" {"}"}</code> to the config file.
        </p>
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
            // Save closes the screen when it worked (first run: and starts the app).
            if (await save()) onDone();
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
  const [scriptsOpen, setScriptsOpen] = useState(false);
  const runCount = repo.scripts?.run?.length ?? 0;
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
        <button className="link" onClick={() => setScriptsOpen(!scriptsOpen)}>
          {scriptsOpen ? "▾" : "▸"} scripts: {[repo.scripts?.setup && "setup", runCount && `${runCount} run`, repo.scripts?.archive && "archive"].filter(Boolean).join(", ") || "none"}
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
      {scriptsOpen && <ScriptsEditor scripts={repo.scripts ?? {}} onChange={(scripts) => props.onChange({ ...repo, scripts })} />}
    </li>
  );
}

/** A repo's setup, run and archive scripts (run through bash in the worktree, with CABOOSE_PORT etc.). */
function ScriptsEditor({ scripts, onChange }: { scripts: RepoScripts; onChange: (s: RepoScripts | undefined) => void }) {
  const set = (patch: Partial<RepoScripts>) => {
    const next = { ...scripts, ...patch };
    const clean: RepoScripts = {
      ...(next.setup?.trim() ? { setup: next.setup } : {}),
      ...(next.archive?.trim() ? { archive: next.archive } : {}),
      ...(next.run?.length ? { run: next.run } : {}),
    };
    onChange(Object.keys(clean).length ? clean : undefined);
  };
  const run = scripts.run ?? [];
  return (
    <div className="scripts-editor">
      <label>
        <span>Setup</span>
        <input value={scripts.setup ?? ""} placeholder="runs in each new worktree, e.g. npm ci" onChange={(e) => set({ setup: e.target.value })} />
      </label>
      {run.map((r, i) => (
        <label key={i}>
          <input className="script-name" value={r.name} placeholder="name" onChange={(e) => set({ run: run.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
          <input value={r.command} placeholder="e.g. PORT=$CABOOSE_PORT npm run dev" onChange={(e) => set({ run: run.map((x, j) => (j === i ? { ...x, command: e.target.value } : x)) })} />
          <button className="link" title="Remove" onClick={() => set({ run: run.filter((_, j) => j !== i) })}>
            ×
          </button>
        </label>
      ))}
      <div className="row">
        <button className="link" onClick={() => set({ run: [...run, { name: run.length ? `run${run.length + 1}` : "run", command: "" }] })}>
          + run script
        </button>
        <small className="muted">The first one is what "Run all" starts. Scripts run through bash in the repo's worktree, with CABOOSE_PORT set.</small>
      </div>
      <label>
        <span>Archive</span>
        <input value={scripts.archive ?? ""} placeholder="runs before the worktree is removed" onChange={(e) => set({ archive: e.target.value })} />
      </label>
    </div>
  );
}

/** Picks repos from Conductor's list, with their copy rules and scripts. */
function ImportFromConductor(props: { onImport: (repos: RepoEntry[], prInstructions?: string) => void; onCancel: () => void }) {
  const [data, setData] = useState<ConductorImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [usePrompt, setUsePrompt] = useState(true);
  useEffect(() => {
    void api.conductorImport().then((r) => {
      if (!r.ok) return setError(r.error);
      setData(r.value);
      setPicked(new Set(r.value.repos.filter((x) => x.exists && !x.alreadyConfigured).map((x) => x.path)));
    });
  }, []);
  if (error) return <div className="scan del">{error}</div>;
  if (!data) return <div className="scan muted">Reading Conductor…</div>;
  if (!data.available) return <div className="scan muted">Conductor is not installed on this machine (no database found). <button className="link" onClick={props.onCancel}>Close</button></div>;
  const toggle = (path: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(path);
    else next.delete(path);
    setPicked(next);
  };
  return (
    <div className="scan import">
      <div className="row">
        <span className="muted">Conductor's repos, with the files each copies into new workspaces and its scripts:</span>
        <span className="spacer" />
        <button className="link" onClick={() => setPicked(new Set(data.repos.filter((x) => x.exists && !x.alreadyConfigured).map((x) => x.path)))}>
          all
        </button>
        <button className="link" onClick={() => setPicked(new Set())}>
          none
        </button>
      </div>
      <div className="import-list">
        {data.repos.map((r) => (
          <label key={r.path} className={`import-row${r.exists && !r.alreadyConfigured ? "" : " unavailable"}`} title={r.path}>
            <input type="checkbox" disabled={!r.exists || r.alreadyConfigured} checked={picked.has(r.path)} onChange={(e) => toggle(r.path, e.target.checked)} />
            <b>{r.name}</b>
            <span className="muted">
              {!r.exists ? "folder not found" : r.alreadyConfigured ? "already added" : `${(r.localFiles ?? []).join("  ")}  ·  from ${r.rulesFrom}`}
              {r.scripts?.run?.length ? `  ·  ${r.scripts.run.length} run script(s)` : ""}
              {r.scripts?.setup ? "  ·  setup" : ""}
            </span>
          </label>
        ))}
      </div>
      {data.prInstructions && (
        <label className="check">
          <input type="checkbox" checked={usePrompt} onChange={(e) => setUsePrompt(e.target.checked)} />
          Also use Conductor's "create PR" prompt as the PR instructions
        </label>
      )}
      <div className="row">
        <button
          className="primary"
          disabled={!picked.size}
          onClick={() =>
            props.onImport(
              data.repos
                .filter((r) => picked.has(r.path))
                .map(({ name, path, localFiles, scripts }) => ({ name, path, localFiles, ...(scripts ? { scripts } : {}) })),
              usePrompt ? data.prInstructions : undefined,
            )
          }
        >
          Add {picked.size} repo{picked.size === 1 ? "" : "s"}
        </button>
        <button onClick={props.onCancel}>Cancel</button>
        <span className="muted">Then Save. Nothing is written to Conductor.</span>
      </div>
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
      <p className="muted">Checks git, bash, the Claude Code and GitHub Copilot logins and the GitHub CLI on this machine. Uses no AI usage.</p>
      <button onClick={runChecks} disabled={running}>
        {running ? "Checking…" : "Run checks"}
      </button>
      {checks && (
        <ul className="doctor">
          {checks.map((c) => (
            <li key={c.name}>
              <span className={c.ok ? "add" : c.optional ? "muted" : "del"}>{c.ok ? "✓" : c.optional ? "–" : "✗"}</span> <b>{c.name}</b>{" "}
              <span className="muted">{c.detail}</span>
              {!c.ok && c.hint && <div className={c.optional ? "hint muted" : "hint"}>{c.hint}</div>}
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
