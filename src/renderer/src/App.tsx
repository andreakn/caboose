import { useEffect, useRef, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import type { DiffComment } from "../../shared/diff.ts";
import {
  type ConfigInfo,
  type Feature,
  type FeatureRepo,
  type UpdateInfo,
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
import { allMerged, Board, HealthDot, JiraStatusChip, PrsView, useOverview } from "./Overview.tsx";
import { DialogHost } from "./Dialog.tsx";
import { NewFeature } from "./NewFeature.tsx";
import { PlanView, StatusChip, useDocs } from "./Plan.tsx";
import { notificationsOn } from "./prefs.ts";
import { FilesView } from "./Files.tsx";
import { repoLabel, setRepoLabels } from "./labels.ts";
import { RetireDialog } from "./Retire.tsx";
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
  const [notice, setNotice] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<Feature | null>(null);
  const activityVersion = useActivityVersion();

  const loadConfig = () =>
    api.config().then((c) => {
      setRepoLabels(c.config.repos);
      setConfig(c);
    });
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
          <UpdateHint />
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
        {!busy && !error && notice && <div className="banner">{notice}</div>}
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
            onArchive={() => setRetiring(feature)}
            onRestore={() => act(`Restoring ${feature.name}…`, () => api.restoreFeature(feature.id))}
          />
        ) : (
          <Empty hasRepos={(config.config.repos ?? []).length > 0} onNew={() => setCreating(true)} />
        )}
      </main>
      {retiring && (
        <RetireDialog
          f={retiring}
          onCancel={() => setRetiring(null)}
          onDone={(mode, r) => {
            setRetiring(null);
            if (!r.ok) return;
            const { archivedTo, closedPrs, warnings } = r.value;
            const what = mode === "archive" ? `Archived ${retiring.name} to ${archivedTo}` : `Deleted ${retiring.name}`;
            const prs = closedPrs.length ? ` · closed PR ${closedPrs.map((n) => `#${n}`).join(", ")}` : "";
            if (warnings.length) setError(`${what}${prs}, but:\n${warnings.join("\n")}`);
            else {
              setNotice(`${what}${prs}.`);
              setTimeout(() => setNotice(null), 10_000);
            }
          }}
        />
      )}
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
  const { ov } = useOverview(f.archived ? undefined : f);
  const setup = f.repos.some((r) => r.setup === "failed") ? "failed" : f.repos.some((r) => r.setup === "running") ? "running" : "ok";
  // Most urgent first: an agent waiting for you, working; every branch merged; finished unseen; else the setup state.
  const [cls, title] = a?.waiting
    ? ["act-waiting", "Needs you"]
    : a?.running
      ? ["act-running", "Working"]
      : allMerged(ov)
        ? ["merged", "Every branch is merged: ready to archive"]
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
      <span className="ws-branch" title={f.repos.map((r) => repoLabel(r.name)).join(" · ")}>
        {f.title || f.repos.map((r) => repoLabel(r.name)).join(" · ") || "no repos"}
      </span>
    </button>
  );
}

type FeatureTab = "chat" | "plan" | "run" | "prs" | "activity";
type RepoTab = "files" | "changes" | "chat" | "run";

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
  // Two levels: the feature (what every repo shares) or one repo (its files, changes, chat, programs).
  const [scopeRaw, setScopeRaw] = useState<string>(() =>
    location.hash === "#changes" ? (f.repos[0]?.name ?? "feature") : (localStorage.getItem(`caboose-scope-${f.id}`) ?? "feature"),
  );
  const scopeRepo = f.repos.find((r) => r.name === scopeRaw);
  const setScope = (s: string) => {
    setScopeRaw(s);
    localStorage.setItem(`caboose-scope-${f.id}`, s);
  };
  const [featureTab, setFeatureTab] = useState<FeatureTab>(location.hash === "#run" ? "run" : "chat");
  /** A feature tab (and the feature level). */
  const setTab = (t: FeatureTab) => {
    setScope("feature");
    setFeatureTab(t);
  };
  const tab = scopeRepo ? null : featureTab;
  const [repoTab, setRepoTabRaw] = useState<RepoTab>(() =>
    location.hash === "#changes" ? "changes" : ((localStorage.getItem("caboose-repo-tab") as RepoTab | null) ?? "files"),
  );
  const setRepoTab = (t: RepoTab) => {
    setRepoTabRaw(t);
    localStorage.setItem("caboose-repo-tab", t);
  };
  const openRepo = (repo: string, t?: RepoTab) => {
    setScope(repo);
    if (t) setRepoTab(t);
  };
  /** The repo's own chat when it has one, else the feature's. */
  const showChat = (repo?: string) => {
    if (repo && props.chats.some((c) => c.repo === repo)) openRepo(repo, "chat");
    else setTab("chat");
  };
  const [changeFile, setChangeFile] = useState<string | null>(null);
  const overview = useOverview(f);
  const openChat = (id: string) => {
    setTab("chat");
    setTimeout(() => dispatch(`selectChat:${id}`));
  };
  const { docs, reload: reloadDocs } = useDocs(f);
  const reported: Record<string, LogEntry | undefined> = {};
  for (const e of docs?.log ?? []) if (e.status) reported[e.from] = e;
  const diff = useFeatureChanges(f);
  const unsent = props.comments.filter((c) => c.author === "user" && !c.sentAt && !c.resolved).length;
  const level = config.config.jira?.level ?? "off";
  const site = config.config.jira?.site;

  const [jira, setJira] = useState<FeatureJira>({ subtasks: {} });
  const loadJira = () => api.featureJira(f.id).then(setJira);
  useEffect(() => void loadJira(), [f.id]);

  const runs = useRunOverview(f, props.terminals, tab === "run" || (Boolean(scopeRepo) && repoTab === "run"));
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
    if (c === "showChat" || c === "focusComposer") {
      if (scopeRepo) setRepoTab("chat");
      else setTab("chat");
    }
    if (c === "showChanges") {
      const repo = scopeRepo ?? f.repos.find((r) => (diff.byRepo[r.name]?.files.length ?? 0) > 0) ?? f.repos[0];
      if (repo) openRepo(repo.name, "changes");
    }
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
  const repoRow = (r: FeatureRepo) => (
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
        openRepo(r.name, "chat");
        if (!props.chats.some((c) => c.repo === r.name)) setTimeout(() => dispatch(`breakOut:${r.name}`));
      }}
      onJiraChanged={() => void loadJira()}
      onAskedAgent={() => showChat(r.name)}
      onOpen={scopeRepo ? undefined : () => openRepo(r.name)}
    />
  );

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
            <>
              <button onClick={props.onRestore}>Restore</button>
              <button className="danger" onClick={props.onArchive} title="Move it to the archive folder, or delete it">
                Archive or delete…
              </button>
            </>
          ) : (
            <>
              <button className="primary" onClick={() => setTab("run")} title="The Run tab: start and stop each repo's programs (Cmd/Ctrl+R runs them all)">
                ▶ Run{running > 0 ? ` (${running})` : ""}
              </button>
              <OpenInMenu path={f.folder} only={["vscode", "terminal", "files"]} />
              <button className="danger" onClick={props.onArchive} title="Archive or delete the feature: closes its open PRs and deletes its branches">
                Archive…
              </button>
            </>
          )}
        </div>
      </header>

      {!f.archived && allMerged(overview.ov) && <MergedOffer f={f} prs={overview.ov!.repos.map((r) => r.pr!.number)} onArchive={props.onArchive} />}

      <NeedsYou f={f} chats={props.chats} reported={reported} onOpenChat={(id) => {
        setTab("chat");
        setTimeout(() => dispatch(`selectChat:${id}`));
      }} />

      <div className="scope-tabs">
        <button
          className={scopeRepo ? "" : "active"}
          onClick={() => setScope("feature")}
          title="What the repos share: the central chat, the plan, every program, the PRs, all activity"
        >
          Feature
        </button>
        {f.repos.map((r) => {
          const n = diff.byRepo[r.name]?.files.length ?? 0;
          const rov = overview.ov?.repos.find((x) => x.name === r.name);
          return (
            <button key={r.name} className={scopeRepo?.name === r.name ? "active" : ""} onClick={() => setScope(r.name)} title={r.path}>
              {rov && <HealthDot r={rov} />}
              {repoLabel(r.name)}
              {n > 0 && <span className="badge">{n}</span>}
            </button>
          );
        })}
      </div>

      {scopeRepo ? (
        <>
          <div className="repos">{repoRow(scopeRepo)}</div>
          <div className="view-tabs">
            <button className={repoTab === "files" ? "active" : ""} onClick={() => setRepoTab("files")}>
              Files
            </button>
            <button className={repoTab === "changes" ? "active" : ""} onClick={() => setRepoTab("changes")}>
              Changes
              {(diff.byRepo[scopeRepo.name]?.files.length ?? 0) > 0 && <span className="badge">{diff.byRepo[scopeRepo.name]!.files.length}</span>}
              {(() => {
                const n = props.comments.filter((c) => c.repo === scopeRepo.name && !c.resolved).length;
                return n > 0 ? <span className="badge comments">💬{n}</span> : null;
              })()}
            </button>
            <button className={repoTab === "chat" ? "active" : ""} onClick={() => setRepoTab("chat")}>
              Chat
              {(() => {
                const n = props.chats.filter((c) => c.repo === scopeRepo.name).length;
                return n > 0 ? <span className="badge">{n}</span> : null;
              })()}
            </button>
            <button className={repoTab === "run" ? "active" : ""} onClick={() => setRepoTab("run")}>
              Run
              {(() => {
                const n = runs.ov?.repos.find((r) => r.repo === scopeRepo.name)?.scripts.filter((x) => x.state === "running").length ?? 0;
                return n > 0 ? <span className="badge ok">{n}</span> : null;
              })()}
            </button>
          </div>
          {repoTab === "files" && (
            <FilesView
              key={scopeRepo.name}
              f={f}
              repo={scopeRepo}
              changes={diff.byRepo[scopeRepo.name]}
              onShowChange={(path) => {
                setChangeFile(path);
                setRepoTab("changes");
              }}
            />
          )}
          {repoTab === "changes" && (
            <ChangesView
              key={scopeRepo.name}
              ws={f}
              repo={scopeRepo}
              unsent={unsent}
              changes={diff.byRepo[scopeRepo.name]}
              error={diff.errors[scopeRepo.name]}
              comments={props.comments.filter((c) => c.repo === scopeRepo.name)}
              refresh={diff.refresh}
              selectedPath={changeFile}
              onSendComments={async () => {
                const chat = props.chats.filter((c) => c.repo === scopeRepo.name).at(-1) ?? activeChat(f, props.chats);
                if (!chat) return;
                const r = await api.sendComments(f.id, chat.id);
                if (r.ok) showChat(chat.repo);
                else alert(r.error);
              }}
            />
          )}
          {repoTab === "chat" && (
            <ChatArea key={scopeRepo.name} ws={f} chats={props.chats.filter((c) => c.repo === scopeRepo.name)} repo={scopeRepo.name} />
          )}
          {repoTab === "run" && <RunView f={f} ov={runs.ov} reload={runs.reload} onShow={showTerminal} only={scopeRepo.name} />}
        </>
      ) : (
        <>
          <div className="repos">
            {f.repos.map(repoRow)}
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
                      {repoLabel(r.name)}
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
          </div>

          <ChatArea ws={f} chats={props.chats} hidden={tab !== "chat"} />
          {tab === "plan" && <PlanView f={f} docs={docs} reload={() => void reloadDocs()} />}
          {tab === "run" && <RunView f={f} ov={runs.ov} reload={runs.reload} onShow={showTerminal} />}
          {tab === "prs" && <PrsView f={f} ov={overview.ov} loading={overview.loading} refresh={() => void overview.refresh()} />}
          {tab === "activity" && <ActivityView f={f} chats={props.chats} onOpenChat={openChat} />}
        </>
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

/** Every branch is merged: offer to archive (once per set of PRs; "Not now" hides it until another PR is merged). */
function MergedOffer({ f, prs, onArchive }: { f: Feature; prs: number[]; onArchive: () => void }) {
  const key = `caboose-merged-offer-${f.id}`;
  const value = [...prs].sort((a, b) => a - b).join(",");
  const [hidden, setHidden] = useState(() => localStorage.getItem(key) === value);
  if (hidden) return null;
  return (
    <div className="merged-offer">
      <span className="hdot h-merged" />
      <span>
        {f.repos.length === 1 ? "Its branch is merged." : `All ${f.repos.length} branches are merged.`} Archive the feature?
      </span>
      <span className="spacer" />
      <button className="primary" onClick={onArchive}>
        Archive…
      </button>
      <button
        onClick={() => {
          localStorage.setItem(key, value);
          setHidden(true);
        }}
      >
        Not now
      </button>
    </div>
  );
}

/** A quiet "new version" button: the checkout is newer than what runs, or GitHub has more. */
function UpdateHint() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const check = (fetch: boolean) => void api.checkForUpdate(fetch).then((r) => r.ok && setInfo(r.value));
    check(true);
    const onFocus = () => check(false);
    window.addEventListener("focus", onFocus);
    const t = setInterval(() => check(true), 30 * 60_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, []);
  if (!info) return null;
  const n = info.newer.length + (info.dirty || info.ahead > 0 ? 0 : info.behind);
  if (n === 0) return null;
  return (
    <button
      className="update-hint"
      disabled={busy}
      title={[...info.commits, ...info.newer].slice(0, 15).join("\n")}
      onClick={async () => {
        if (!confirm(`Restart Caboose into the new version (${n} commit${n === 1 ? "" : "s"})? Running chats and programs are stopped.`)) return;
        setBusy(true);
        const r = await api.update(); // only returns if it failed
        setBusy(false);
        if (!r.ok) alert(r.error);
      }}
    >
      {busy ? "Updating…" : `⬆ New version (${n}) · restart`}
    </button>
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
          {c.repo ? `${repoLabel(c.repo)}'s chat` : c.title} is asking
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
