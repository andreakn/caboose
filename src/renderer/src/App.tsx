import { useEffect, useRef, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import type { DiffComment } from "../../shared/diff.ts";
import {
  type ConfigInfo,
  type Feature,
  FEATURE_STATUSES,
  type FeatureJira,
  type JiraAlignment,
  type RepoScripts,
  type Result,
  type State,
  type Terminal,
} from "../../shared/types.ts";
import { type Activity, activityOf, onActivityNotice, useActivityVersion } from "./activity.ts";
import { ChangesView, useFeatureChanges } from "./Changes.tsx";
import { activeChat, ChatArea } from "./Chat.tsx";
import { dispatch, useCommand } from "./commands.ts";
import { Configure } from "./Configure.tsx";
import { JiraChip, RepoRow } from "./GitHub.tsx";
import { MenuButton, OpenInMenu } from "./Menu.tsx";
import { NewFeature } from "./NewFeature.tsx";
import { notificationsOn } from "./prefs.ts";
import { TerminalPanel, useTerminals } from "./Terminals.tsx";

const api = window.caboose;

type Screen = "feature" | "configure" | "new";

export function App() {
  const terminals = useTerminals();
  const [state, setState] = useState<State>({ features: [], chats: [], comments: [] });
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [screen, setScreen] = useState<Screen>("feature");
  const [selected, setSelectedRaw] = useState<string | null>(() => localStorage.getItem("caboose-selected"));
  const select = (id: string) => {
    setSelectedRaw(id);
    localStorage.setItem("caboose-selected", id);
    setScreen("feature");
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activityVersion = useActivityVersion();

  const loadConfig = () => api.config().then(setConfig);
  useEffect(() => {
    void api.getState().then(setState);
    void loadConfig();
    return api.onStateChanged(setState);
  }, []);

  // System notifications while Caboose is in the background; clicking one opens the chat.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(
    () =>
      onActivityNotice(({ chatId, kind }) => {
        if (!notificationsOn() || document.hasFocus()) return;
        const s = stateRef.current;
        const chat = s.chats.find((c) => c.id === chatId);
        const f = chat && s.features.find((x) => x.id === chat.featureId);
        if (!chat || !f) return;
        const who = chat.agent === "copilot" ? "Copilot" : "Claude";
        const n = new Notification(kind === "done" ? `${f.name}: ${who} is done` : `${f.name}: ${who} needs you`, {
          body: chat.title,
          silent: kind === "done",
        });
        n.onclick = () => {
          api.focusWindow();
          select(f.id);
          setTimeout(() => {
            dispatch("showChat");
            dispatch(`selectChat:${chat.id}`);
          });
        };
      }),
    [],
  );

  // Dock/taskbar badge: chats that finished unseen or wait for an answer.
  useEffect(() => {
    const count = state.chats.filter((c) => {
      const a = activityOf([c.id]);
      return a.unread || a.waiting > 0;
    }).length;
    api.setBadge(count);
  }, [activityVersion, state.chats]);

  /** Runs an action, showing `label` while it runs and any error after. */
  async function act<T>(label: string, fn: () => Promise<Result<T> | null>): Promise<T | undefined> {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      if (r && !r.ok) setError(r.error);
      return r?.ok ? r.value : undefined;
    } finally {
      setBusy(null);
    }
  }

  const live = state.features.filter((f) => !f.archived);
  const archived = state.features.filter((f) => f.archived);
  // Fall back to the newest live feature when the remembered one is gone.
  const feature = state.features.find((f) => f.id === selected) ?? live.at(-1);
  const activity = (f: Feature) => activityOf(state.chats.filter((c) => c.featureId === f.id).map((c) => c.id));

  useCommand((c) => {
    if (c === "settings" || c === "addRepo") setScreen((s) => (s === "configure" ? "feature" : "configure"));
    if (c === "newFeature") setScreen("new");
    if ((c === "nextFeature" || c === "prevFeature") && live.length) {
      const i = live.findIndex((f) => f.id === feature?.id);
      select(live[(i + (c === "nextFeature" ? 1 : -1) + live.length) % live.length].id);
    }
  });

  if (!config) return null;
  if (config.firstRun) {
    return (
      <div className="app">
        <main className="main">
          <Configure onDone={() => void loadConfig()} />
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">🚃 Caboose</div>
        <button className="new-feature" onClick={() => setScreen("new")}>
          + New feature
        </button>
        <section className="repo">
          {live.map((f) => (
            <FeatureRow
              key={f.id}
              f={f}
              activity={activity(f)}
              active={screen === "feature" && f.id === feature?.id}
              onClick={() => select(f.id)}
            />
          ))}
          {archived.length > 0 && (
            <details className="archived">
              <summary>Archived ({archived.length})</summary>
              {archived.map((f) => (
                <FeatureRow key={f.id} f={f} active={screen === "feature" && f.id === feature?.id} onClick={() => select(f.id)} />
              ))}
            </details>
          )}
        </section>
        <div className="sidebar-foot">
          <button
            className={`link${screen === "configure" ? " active" : ""}`}
            onClick={() => setScreen(screen === "configure" ? "feature" : "configure")}
          >
            ⚙ Configure
          </button>
        </div>
      </aside>

      <main className="main">
        {(busy || error) && <div className={busy ? "banner" : "banner error"}>{busy ?? error}</div>}
        {screen === "configure" ? (
          <Configure
            onDone={() => {
              void loadConfig();
              setScreen("feature");
            }}
          />
        ) : screen === "new" ? (
          <NewFeature config={config.config} onCreated={(f) => select(f.id)} onCancel={() => setScreen("feature")} />
        ) : feature ? (
          <FeatureView
            key={feature.id}
            feature={feature}
            config={config}
            chats={state.chats.filter((c) => c.featureId === feature.id)}
            comments={state.comments.filter((c) => c.featureId === feature.id)}
            terminals={terminals.filter((t) => t.featureId === feature.id)}
            onArchive={() => {
              if (confirm(`Archive ${feature.name}? Its worktrees are removed; the branches and the folder stay.`)) {
                void act(`Archiving ${feature.name}…`, () => api.archiveFeature(feature.id));
              }
            }}
            onRestore={() => act(`Restoring ${feature.name}…`, () => api.restoreFeature(feature.id))}
          />
        ) : (
          <Empty hasRepos={(config.config.repos ?? []).length > 0} onNew={() => setScreen("new")} />
        )}
      </main>
    </div>
  );
}

function FeatureRow(props: { f: Feature; activity?: Activity; active: boolean; onClick: () => void }) {
  const { f, active, onClick, activity: a } = props;
  const setup = f.repos.some((r) => r.setup === "failed") ? "failed" : f.repos.some((r) => r.setup === "running") ? "running" : "ok";
  // Most urgent first: an agent waiting for you, working, finished unseen; else the setup state.
  const [cls, title] = a?.waiting
    ? ["act-waiting", "Needs you"]
    : a?.running
      ? ["act-running", "Working"]
      : a?.unread
        ? ["act-unread", "Done"]
        : [`setup-${setup}`, `Setup: ${setup}`];
  return (
    <button className={`ws-row${active ? " active" : ""}${f.archived ? " is-archived" : ""}`} onClick={onClick}>
      <span className={`dot ${cls}`} title={title} />
      <span className="ws-name">
        {f.name}
        {f.status && f.status !== "active" && <span className={`status-mini st-${f.status}`}>{f.status}</span>}
      </span>
      <span className="ws-branch" title={f.repos.map((r) => r.name).join(" · ")}>
        {f.title || f.repos.map((r) => r.name).join(" · ") || "no repos"}
      </span>
    </button>
  );
}

function FeatureView(props: {
  feature: Feature;
  config: ConfigInfo;
  chats: Chat[];
  comments: DiffComment[];
  terminals: Terminal[];
  onArchive: () => void;
  onRestore: () => void;
}) {
  const { feature: f, config } = props;
  const [tab, setTab] = useState<"chat" | "changes">(location.hash === "#changes" ? "changes" : "chat");
  const [repoTab, setRepoTab] = useState<string | null>(null);
  const diff = useFeatureChanges(f);
  const fileCount = Object.values(diff.byRepo).reduce((n, c) => n + (c?.files.length ?? 0), 0);
  const openComments = props.comments.filter((c) => !c.resolved).length;
  const unsent = props.comments.filter((c) => c.author === "user" && !c.sentAt && !c.resolved).length;
  const level = config.config.jira?.level ?? "off";
  const site = config.config.jira?.site;

  const [jira, setJira] = useState<FeatureJira>({ subtasks: {} });
  const loadJira = () => api.featureJira(f.id).then(setJira);
  useEffect(() => void loadJira(), [f.id]);

  // Each repo's run scripts.
  const [scripts, setScripts] = useState<Record<string, RepoScripts>>({});
  const repoKey = f.repos.map((r) => r.name).join();
  useEffect(() => {
    void Promise.all(f.repos.map(async (r) => [r.name, await api.repoScripts(f.id, r.name)] as const)).then((e) =>
      setScripts(Object.fromEntries(e)),
    );
  }, [f.id, repoKey, config]);
  const runs = f.repos.flatMap((r) => (scripts[r.name]?.run ?? []).map((s) => ({ repo: r.name, script: s.name })));

  const [termOpen, setTermOpenRaw] = useState(() => localStorage.getItem(`caboose-term-open-${f.id}`) === "1");
  const [termActive, setTermActive] = useState<string | null>(null);
  const setTermOpen = (open: boolean) => {
    setTermOpenRaw(open);
    localStorage.setItem(`caboose-term-open-${f.id}`, open ? "1" : "0");
  };
  async function run(repo: string, script?: string) {
    const r = await api.runScript(f.id, repo, script);
    if (!r.ok) return alert(r.error);
    setTermActive(r.value.id);
    setTermOpen(true);
  }
  /** Each repo's first (default) script. */
  const runAll = () => f.repos.filter((r) => scripts[r.name]?.run?.length).forEach((r) => void run(r.name));

  /** Says what linking Jira changed. */
  const reportAlignment = (r: Result<JiraAlignment>) => {
    if (!r.ok) return alert(r.error);
    const { created, renamed, skipped } = r.value;
    const lines = [
      created.length ? `Created subtasks: ${created.join(", ")}` : "",
      ...renamed.map((x) => `${x.repo}: branch renamed to ${x.to}`),
      skipped.length ? `Not renamed (already pushed): ${skipped.join(", ")}` : "",
    ].filter(Boolean);
    if (lines.length) alert(lines.join("\n"));
  };

  useCommand(async (c) => {
    if (c === "showChat" || c === "focusComposer") setTab("chat");
    if (c === "showChanges") setTab("changes");
    if (c === "toggleTerminal" && !f.archived) setTermOpen(!termOpen);
    if (c === "run" && !f.archived) runAll();
    if (c === "newTerminal" && !f.archived) {
      const r = await api.openShell(f.id, f.repos[0]?.name);
      if (!r.ok) return alert(r.error);
      setTermActive(r.value.id);
      setTermOpen(true);
    }
  });

  const missing = (config.config.repos ?? []).filter((r) => !f.repos.some((x) => x.name === r.name));
  const shownRepo = f.repos.find((r) => r.name === repoTab) ?? f.repos[0];

  return (
    <div className="ws-view">
      <header className="ws-header">
        <div>
          <h1>
            {f.name}{" "}
            <select
              className={`status-chip st-${f.status ?? "active"}`}
              value={f.status ?? "active"}
              disabled={f.archived}
              title="Status"
              onChange={(e) => void api.setFeatureDetails(f.id, { status: e.target.value as Feature["status"] })}
            >
              {FEATURE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            {level !== "off" && (
              <JiraChip
                label="Jira task"
                jiraKey={jira.task}
                site={site}
                onSet={async (key) => {
                  reportAlignment(await api.setFeatureTask(f.id, key));
                  void loadJira();
                }}
              />
            )}
          </h1>
          <FeatureTitle f={f} />
        </div>
        <div className="actions">
          {f.archived ? (
            <button onClick={props.onRestore}>Restore</button>
          ) : (
            <>
              {runs.length > 0 && (
                <MenuButton
                  className="primary"
                  title="Run a repo's script in a terminal (Cmd/Ctrl+R runs each repo's first one)"
                  label="▶ Run ▾"
                  align="right"
                  items={[
                    ...runs.map((x) => ({ label: `${x.repo} · ${x.script}`, onClick: () => void run(x.repo, x.script) })),
                    ...(runs.length > 1 ? (["separator", { label: "Run all (first script of each repo)", onClick: runAll }] as const) : []),
                  ]}
                />
              )}
              <OpenInMenu path={f.folder} only={["vscode", "terminal", "files"]} />
              <button className="danger" onClick={props.onArchive}>
                Archive
              </button>
            </>
          )}
        </div>
      </header>

      <div className="repos">
        {f.repos.map((r) => (
          <RepoRow
            key={r.name}
            feature={f}
            repo={r}
            chats={props.chats}
            jiraLevel={level}
            jiraKey={jira.subtasks[r.name] ?? jira.task}
            subtask={jira.subtasks[r.name]}
            hasTask={Boolean(jira.task)}
            jiraSite={site}
            prInstructions={config.config.prInstructions}
            onJiraChanged={() => void loadJira()}
            onAskedAgent={() => setTab("chat")}
          />
        ))}
        {!f.archived && missing.length > 0 && (
          <div className="add-repo-row">
            <select
              value=""
              onChange={async (e) => {
                const name = e.target.value;
                if (!name) return;
                const r = await api.addRepoToFeature(f.id, name);
                if (!r.ok) alert(r.error);
                void loadJira();
              }}
            >
              <option value="">+ Add a repo to this feature…</option>
              {missing.map((r) => (
                <option key={r.name} value={r.name}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <details className="ws-info">
        <summary>
          Feature details · ports {f.port}–{f.port + 99}
        </summary>
        <dl className="facts">
          <dt>Folder</dt>
          <dd>
            <code>{f.folder}</code>
          </dd>
          {f.repos.map((r, i) => (
            <SetupFacts key={r.name} f={f} repo={r.name} setup={r.setup} port={f.port + 10 * i} path={r.path} copied={r.copied} />
          ))}
          <dt>Created</dt>
          <dd>{new Date(f.createdAt).toLocaleString()}</dd>
        </dl>
      </details>

      <div className="view-tabs">
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          Chat
        </button>
        <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          Changes{fileCount > 0 && <span className="badge">{fileCount}</span>}
          {openComments > 0 && <span className="badge comments">💬{openComments}</span>}
        </button>
        {tab === "changes" && f.repos.length > 1 && (
          <div className="repo-tabs">
            {f.repos.map((r) => (
              <button key={r.name} className={r.name === shownRepo?.name ? "active" : ""} onClick={() => setRepoTab(r.name)}>
                {r.name}
                {(diff.byRepo[r.name]?.files.length ?? 0) > 0 && <span className="badge">{diff.byRepo[r.name]!.files.length}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      <ChatArea ws={f} chats={props.chats} hidden={tab !== "chat"} />
      {tab === "changes" && shownRepo && (
        <ChangesView
          key={shownRepo.name}
          ws={f}
          repo={shownRepo}
          unsent={unsent}
          changes={diff.byRepo[shownRepo.name]}
          error={diff.errors[shownRepo.name]}
          comments={props.comments.filter((c) => c.repo === shownRepo.name)}
          refresh={diff.refresh}
          onSendComments={async () => {
            const chat = activeChat(f, props.chats);
            if (!chat) return;
            const r = await api.sendComments(f.id, chat.id);
            if (r.ok) setTab("chat");
            else alert(r.error);
          }}
        />
      )}
      <TerminalPanel
        ws={f}
        terminals={props.terminals}
        open={termOpen}
        setOpen={setTermOpen}
        activeId={termActive}
        setActiveId={setTermActive}
      />
    </div>
  );
}

/** The feature's title, edited in place (click it). */
function FeatureTitle({ f }: { f: Feature }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(f.title ?? "");
  useEffect(() => setText(f.title ?? ""), [f.title]);
  const save = () => {
    setEditing(false);
    if (text.trim() !== (f.title ?? "")) void api.setFeatureDetails(f.id, { title: text });
  };
  if (editing) {
    return (
      <input
        className="title-edit"
        autoFocus
        value={text}
        placeholder="What is this feature about?"
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setText(f.title ?? "");
            setEditing(false);
          }
        }}
      />
    );
  }
  return (
    <div className="feature-title" onClick={() => !f.archived && setEditing(true)} title={f.folder}>
      {f.title ? <span>{f.title}</span> : <span className="muted">{f.archived ? "" : "+ add a title"}</span>}
    </div>
  );
}

function SetupFacts(props: { f: Feature; repo: string; setup: string; port: number; path: string; copied?: string[] }) {
  const [log, setLog] = useState("");
  useEffect(() => {
    void api.setupLog(props.f.id, props.repo).then(setLog);
  }, [props.f.id, props.repo, props.setup]);
  return (
    <>
      <dt>{props.repo}</dt>
      <dd>
        <code>{props.path}</code> · CABOOSE_PORT <code>{props.port}</code> · setup{" "}
        {{ none: "not configured", running: "running…", ok: "done", failed: "failed" }[props.setup]}
        <div className="copied">
          <span className="muted">Local files from the main checkout:</span>{" "}
          {props.copied?.length ? props.copied.map((c) => <code key={c}>{c}</code>) : <span className="muted">none</span>}{" "}
          {!props.f.archived && (
            <button
              className="link"
              title="Copy them again from the main checkout, overwriting the feature's copies"
              onClick={async () => {
                if (!confirm(`Copy ${props.repo}'s local files from its main checkout again? Changed copies in the feature are overwritten.`)) return;
                const r = await api.copyLocalFilesAgain(props.f.id, props.repo);
                alert(r.ok ? `Copied ${r.value.length} file(s)${r.value.length ? `:\n${r.value.join("\n")}` : "."}` : r.error);
              }}
            >
              ↻ copy again
            </button>
          )}
        </div>
        {log && <pre className="log">{log}</pre>}
      </dd>
    </>
  );
}

function Empty({ hasRepos, onNew }: { hasRepos: boolean; onNew: () => void }) {
  return (
    <div className="empty">
      <div className="empty-icon">🚃</div>
      <h1>All aboard</h1>
      <p className="muted">
        {hasRepos
          ? "Start a feature: it gets a station name, a folder, and a worktree for each repo you pick."
          : "Add your repositories in Configure first."}
      </p>
      {hasRepos && (
        <button className="primary" onClick={onNew}>
          + New feature
        </button>
      )}
    </div>
  );
}
