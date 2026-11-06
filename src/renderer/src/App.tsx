import { useEffect, useRef, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import type { DiffComment } from "../../shared/diff.ts";
import {
  type ConfigInfo,
  type Feature,
  FEATURE_STATUSES,
  type FeatureJira,
  type JiraAlignment,
  type LogEntry,
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
import { ActivityView } from "./Activity.tsx";
import { OpenInMenu } from "./Menu.tsx";
import { Board, JiraStatusChip, PrsView, useOverview } from "./Overview.tsx";
import { DialogHost } from "./Dialog.tsx";
import { NewFeature } from "./NewFeature.tsx";
import { PlanView, StatusChip, useDocs } from "./Plan.tsx";
import { notificationsOn } from "./prefs.ts";
import { RunView, useRunOverview } from "./Run.tsx";
import { TerminalPanel, useTerminals } from "./Terminals.tsx";

const api = window.caboose;

type Screen = "feature" | "configure" | "board";

export function App() {
  const terminals = useTerminals();
  const [state, setState] = useState<State>({ features: [], chats: [], comments: [] });
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [screen, setScreen] = useState<Screen>("feature");
  const [creating, setCreating] = useState(false);
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
    if (c === "newFeature") setCreating(true);
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
        <DialogHost />
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">🚃 Caboose</div>
        <button className={`board-link${screen === "board" ? " active" : ""}`} onClick={() => setScreen("board")}>
          ▦ Board
        </button>
        <button className="new-feature" onClick={() => setCreating(true)}>
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
        {screen === "board" ? (
          <Board features={state.features} chats={state.chats} onOpen={select} onNew={() => setCreating(true)} />
        ) : screen === "configure" ? (
          <Configure
            onSaved={() => void loadConfig()}
            onDone={() => {
              void loadConfig();
              setScreen("feature");
            }}
          />
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
          <Empty hasRepos={(config.config.repos ?? []).length > 0} onNew={() => setCreating(true)} />
        )}
      </main>
      {creating && (
        <NewFeature
          config={config.config}
          onCreated={(f) => {
            setCreating(false);
            select(f.id);
          }}
          onCancel={() => setCreating(false)}
        />
      )}
      <DialogHost />
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
  const [tab, setTab] = useState<"chat" | "changes" | "plan" | "run" | "prs" | "activity">(
    location.hash === "#changes" ? "changes" : location.hash === "#run" ? "run" : "chat",
  );
  const overview = useOverview(f);
  const openChat = (id: string) => {
    setTab("chat");
    setTimeout(() => dispatch(`selectChat:${id}`));
  };
  const { docs, reload: reloadDocs } = useDocs(f);
  const reported: Record<string, LogEntry | undefined> = {};
  for (const e of docs?.log ?? []) if (e.status) reported[e.from] = e;
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

  const runs = useRunOverview(f, props.terminals, tab === "run");
  const running = runs.ov?.repos.reduce((n, r) => n + r.scripts.filter((x) => x.state === "running").length, 0) ?? 0;

  const [termOpen, setTermOpenRaw] = useState(() => localStorage.getItem(`caboose-term-open-${f.id}`) === "1");
  const [termActive, setTermActive] = useState<string | null>(null);
  const setTermOpen = (open: boolean) => {
    setTermOpenRaw(open);
    localStorage.setItem(`caboose-term-open-${f.id}`, open ? "1" : "0");
  };
  const showTerminal = (id: string) => {
    setTermActive(id);
    setTermOpen(true);
  };
  /** Every program of every repo that is not running. */
  const runAll = async () => {
    const r = await api.runStartAll(f.id);
    if (!r.ok) alert(r.error);
    void runs.reload();
  };

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
    if (c === "run" && !f.archived) {
      setTab("run");
      void runAll();
    }
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
            {level !== "off" &&
              (jira.task ? (
                <span className="jira-chip">
                  <JiraStatusChip j={overview.ov?.task ?? { key: jira.task }} site={site} />
                  <button
                    className="link"
                    title="Unlink the Jira task"
                    onClick={async () => {
                      if (!confirm(`Unlink ${jira.task}?`)) return;
                      reportAlignment(await api.setFeatureTask(f.id, null));
                      void loadJira();
                    }}
                  >
                    ×
                  </button>
                </span>
              ) : (
                <JiraChip
                  label="Jira task"
                  site={site}
                  onSet={async (key) => {
                    reportAlignment(await api.setFeatureTask(f.id, key));
                    void loadJira();
                    void overview.reload();
                  }}
                />
              ))}
          </h1>
          <FeatureTitle f={f} />
        </div>
        <div className="actions">
          {f.archived ? (
            <button onClick={props.onRestore}>Restore</button>
          ) : (
            <>
              <button className="primary" onClick={() => setTab("run")} title="The Run tab: start and stop each repo's programs (Cmd/Ctrl+R runs them all)">
                ▶ Run{running > 0 ? ` (${running})` : ""}
              </button>
              <OpenInMenu path={f.folder} only={["vscode", "terminal", "files"]} />
              <button className="danger" onClick={props.onArchive}>
                Archive
              </button>
            </>
          )}
        </div>
      </header>

      <NeedsYou f={f} chats={props.chats} reported={reported} onOpenChat={(id) => {
        setTab("chat");
        setTimeout(() => dispatch(`selectChat:${id}`));
      }} />

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
            ov={overview.ov?.repos.find((x) => x.name === r.name)}
            onChanged={() => void overview.reload()}
            hasChat={props.chats.some((c) => c.repo === r.name)}
            onChat={() => {
              setTab("chat");
              setTimeout(() => dispatch(`breakOut:${r.name}`));
            }}
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
        <button className={tab === "plan" ? "active" : ""} onClick={() => setTab("plan")}>
          Plan
          {docs && docs.progress.total > 0 && (
            <span className="badge">
              {docs.progress.done}/{docs.progress.total}
            </span>
          )}
        </button>
        <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          Changes{fileCount > 0 && <span className="badge">{fileCount}</span>}
          {openComments > 0 && <span className="badge comments">💬{openComments}</span>}
        </button>
        <button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
          Run{running > 0 && <span className="badge ok">{running}</span>}
        </button>
        <button className={tab === "prs" ? "active" : ""} onClick={() => setTab("prs")}>
          Pull requests
          {(() => {
            const n = overview.ov?.repos.filter((r) => r.pr && (r.pr.state === "OPEN" || r.pr.state === "DRAFT")).length ?? 0;
            return n > 0 ? <span className="badge">{n}</span> : null;
          })()}
        </button>
        <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
          Activity
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
      {tab === "plan" && <PlanView f={f} docs={docs} reload={() => void reloadDocs()} />}
      {tab === "run" && <RunView f={f} ov={runs.ov} reload={runs.reload} onShow={showTerminal} />}
      {tab === "prs" && <PrsView f={f} ov={overview.ov} loading={overview.loading} refresh={() => void overview.refresh()} />}
      {tab === "activity" && <ActivityView f={f} chats={props.chats} onOpenChat={openChat} />}
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

/** Only what waits for you: chats with a question or approval, repos that reported needs-input or blocked. */
function NeedsYou(props: { f: Feature; chats: Chat[]; reported: Record<string, LogEntry | undefined>; onOpenChat: (id: string) => void }) {
  useActivityVersion();
  const waiting = props.chats.filter((c) => activityOf([c.id]).waiting > 0);
  const stuck = Object.entries(props.reported).filter(([, e]) => e && (e.status === "needs-input" || e.status === "blocked"));
  if (!waiting.length && !stuck.length) return null;
  return (
    <div className="needs-you">
      <b>Needs you:</b>
      {waiting.map((c) => (
        <button key={c.id} className="link" onClick={() => props.onOpenChat(c.id)}>
          {c.repo ? `${c.repo}'s chat` : c.title} is asking
        </button>
      ))}
      {stuck.map(([repo, e]) => {
        const chat = props.chats.filter((c) => c.repo === repo).at(-1);
        return (
          <button key={repo} className="link" title={e!.text} onClick={() => chat && props.onOpenChat(chat.id)}>
            {repo}: {e!.status} — {e!.text.split("\n")[0].slice(0, 80)}
          </button>
        );
      })}
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
