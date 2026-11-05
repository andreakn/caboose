import { useEffect, useRef, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import type { RepoConfig, Repo, Result, State, Terminal, Workspace } from "../../shared/types.ts";
import type { DiffComment } from "../../shared/diff.ts";
import { ChangesView, useChanges } from "./Changes.tsx";
import { activeChat, ChatArea } from "./Chat.tsx";
import { BranchName, GitHubBar, useGitHub } from "./GitHub.tsx";
import { TerminalPanel, useTerminals } from "./Terminals.tsx";
import { type Activity, activityOf, onActivityNotice, useActivityVersion } from "./activity.ts";
import { dispatch, useCommand } from "./commands.ts";
import { notificationsOn } from "./prefs.ts";
import { Settings } from "./Settings.tsx";

const api = window.caboose;

export function App() {
  const terminals = useTerminals();
  const [state, setState] = useState<State>({ repos: [], workspaces: [], chats: [], comments: [] });
  const [selected, setSelectedRaw] = useState<string | null>(() => localStorage.getItem("caboose-selected"));
  const setSelected = (id: string | null) => {
    setSelectedRaw(id);
    if (id) localStorage.setItem("caboose-selected", id);
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const activityVersion = useActivityVersion();

  useEffect(() => {
    void api.getState().then(setState);
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
        const w = chat && s.workspaces.find((x) => x.id === chat.workspaceId);
        if (!chat || !w) return;
        const n = new Notification(kind === "done" ? `${w.name}: Claude is done` : `${w.name}: Claude needs you`, {
          body: chat.title,
          silent: kind === "done",
        });
        n.onclick = () => {
          api.focusWindow();
          setShowSettings(false);
          setSelected(w.id);
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

  // Fall back to the first live workspace when the remembered one is gone.
  const ws =
    state.workspaces.find((w) => w.id === selected) ?? state.workspaces.find((w) => !w.archived);
  const repoOf = (w: Workspace) => state.repos.find((r) => r.id === w.repoId);
  const activity = (w: Workspace) => activityOf(state.chats.filter((c) => c.workspaceId === w.id).map((c) => c.id));
  // Sidebar order, for next/previous.
  const live = state.repos.flatMap((r) => state.workspaces.filter((w) => w.repoId === r.id && !w.archived));

  async function newWorkspace(repoId: string) {
    const repo = state.repos.find((r) => r.id === repoId);
    const w = await act(`Creating a workspace in ${repo?.name}…`, () => api.createWorkspace(repoId));
    if (w) {
      setShowSettings(false);
      setSelected(w.id);
    }
  }

  useCommand((c) => {
    if (c === "settings") setShowSettings((s) => !s);
    if (c === "addRepo") void act("Adding repository…", () => api.pickAndAddRepo());
    if (c === "newWorkspace") {
      const repoId = ws?.repoId ?? state.repos[0]?.id;
      if (repoId) void newWorkspace(repoId);
    }
    if ((c === "nextWorkspace" || c === "prevWorkspace") && live.length) {
      const i = live.findIndex((w) => w.id === ws?.id);
      const next = live[(i + (c === "nextWorkspace" ? 1 : -1) + live.length) % live.length];
      setShowSettings(false);
      setSelected(next.id);
    }
  });

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">🚃 Caboose</div>
        {state.repos.map((repo) => (
          <RepoGroup
            key={repo.id}
            repo={repo}
            workspaces={state.workspaces.filter((w) => w.repoId === repo.id)}
            selected={showSettings ? null : (ws?.id ?? null)}
            activity={activity}
            onSelect={(id) => {
              setShowSettings(false);
              setSelected(id);
            }}
            onNew={() => newWorkspace(repo.id)}
            onRemove={() => act(`Removing ${repo.name}…`, () => api.removeRepo(repo.id))}
          />
        ))}
        <button className="add-repo" onClick={() => act("Adding repository…", () => api.pickAndAddRepo())}>
          + Add repository
        </button>
        <div className="sidebar-foot">
          <button className={`link${showSettings ? " active" : ""}`} onClick={() => setShowSettings(!showSettings)}>
            ⚙ Settings
          </button>
        </div>
      </aside>

      <main className="main">
        {(busy || error) && <div className={busy ? "banner" : "banner error"}>{busy ?? error}</div>}
        {showSettings ? (
          <Settings onClose={() => setShowSettings(false)} />
        ) : ws ? (
          <WorkspaceView
            ws={ws}
            repo={repoOf(ws)}
            chats={state.chats.filter((c) => c.workspaceId === ws.id)}
            comments={state.comments.filter((c) => c.workspaceId === ws.id)}
            terminals={terminals.filter((t) => t.workspaceId === ws.id)}
            onArchive={() => act(`Archiving ${ws.name}…`, () => api.archiveWorkspace(ws.id))}
            onRestore={() => act(`Restoring ${ws.name}…`, () => api.restoreWorkspace(ws.id))}
          />
        ) : (
          <Empty hasRepos={state.repos.length > 0} />
        )}
      </main>
    </div>
  );
}

function RepoGroup(props: {
  repo: Repo;
  workspaces: Workspace[];
  selected: string | null;
  activity: (w: Workspace) => Activity;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRemove: () => void;
}) {
  const { repo, workspaces } = props;
  const live = workspaces.filter((w) => !w.archived);
  const archived = workspaces.filter((w) => w.archived);
  return (
    <section className="repo">
      <div className="repo-head">
        <span className="repo-name" title={repo.path}>
          {repo.name}
        </span>
        <button className="icon" title="New workspace" onClick={props.onNew}>
          +
        </button>
        {live.length === 0 && (
          <button className="icon" title="Remove repository from Caboose" onClick={props.onRemove}>
            ×
          </button>
        )}
      </div>
      {live.map((w) => (
        <WorkspaceRow
          key={w.id}
          w={w}
          activity={props.activity(w)}
          active={w.id === props.selected}
          onClick={() => props.onSelect(w.id)}
        />
      ))}
      {archived.length > 0 && (
        <details className="archived">
          <summary>Archived ({archived.length})</summary>
          {archived.map((w) => (
            <WorkspaceRow key={w.id} w={w} active={w.id === props.selected} onClick={() => props.onSelect(w.id)} />
          ))}
        </details>
      )}
    </section>
  );
}

function WorkspaceRow(props: { w: Workspace; activity?: Activity; active: boolean; onClick: () => void }) {
  const { w, active, onClick, activity: a } = props;
  // Most urgent first: Claude waiting for you, working, finished unseen; else the setup state.
  const [cls, title] = a?.waiting
    ? ["act-waiting", "Claude needs you"]
    : a?.running
      ? ["act-running", "Claude is working"]
      : a?.unread
        ? ["act-unread", "Claude is done"]
        : [`setup-${w.setup}`, `Setup: ${w.setup}`];
  return (
    <button className={`ws-row${active ? " active" : ""}${w.archived ? " is-archived" : ""}`} onClick={onClick}>
      <span className={`dot ${cls}`} title={title} />
      <span className="ws-name">{w.name}</span>
      <span className="ws-branch">{w.branch}</span>
    </button>
  );
}

function WorkspaceView(props: {
  ws: Workspace;
  repo?: Repo;
  chats: Chat[];
  comments: DiffComment[];
  terminals: Terminal[];
  onArchive: () => void;
  onRestore: () => void;
}) {
  const { ws } = props;
  const [log, setLog] = useState("");
  const [tab, setTab] = useState<"chat" | "changes">(location.hash === "#changes" ? "changes" : "chat");
  const diff = useChanges(ws);
  const gh = useGitHub(ws, props.chats);
  const fileCount = diff.changes?.files.length ?? 0;
  const openComments = props.comments.filter((c) => !c.resolved).length;

  const [config, setConfig] = useState<RepoConfig>({});
  useEffect(() => {
    void api.repoConfig(ws.id).then(setConfig);
  }, [ws.id]);
  const [termOpen, setTermOpenRaw] = useState(() => localStorage.getItem(`caboose-term-open-${ws.id}`) === "1");
  const [termActive, setTermActive] = useState<string | null>(null);
  useEffect(() => {
    setTermOpenRaw(localStorage.getItem(`caboose-term-open-${ws.id}`) === "1");
    setTermActive(null);
  }, [ws.id]);
  const setTermOpen = (open: boolean) => {
    setTermOpenRaw(open);
    localStorage.setItem(`caboose-term-open-${ws.id}`, open ? "1" : "0");
  };
  const run = props.terminals.find((t) => t.kind === "run");
  const running = run && run.exitCode === undefined;

  async function startRun() {
    const r = await api.runScript(ws.id);
    if (!r.ok) return alert(r.error);
    setTermActive(r.value.id);
    setTermOpen(true);
  }

  useCommand(async (c) => {
    if (c === "showChat" || c === "focusComposer") setTab("chat");
    if (c === "showChanges") setTab("changes");
    if (c === "toggleTerminal" && !ws.archived) setTermOpen(!termOpen);
    if (c === "run" && config.run && !ws.archived) void startRun();
    if (c === "newTerminal" && !ws.archived) {
      const r = await api.openShell(ws.id);
      if (!r.ok) return alert(r.error);
      setTermActive(r.value.id);
      setTermOpen(true);
    }
  });
  useEffect(() => {
    void api.setupLog(ws.id).then(setLog);
  }, [ws.id, ws.setup]);

  return (
    <div className="ws-view">
      <header className="ws-header">
        <div>
          <h1>{ws.name}</h1>
          <div className="muted">
            {props.repo?.name} · <BranchName ws={ws} status={gh.status} onRenamed={gh.refresh} /> from{" "}
            <code>{ws.baseRef}</code>
          </div>
        </div>
        <div className="actions">
          {ws.archived ? (
            <button onClick={props.onRestore}>Restore</button>
          ) : (
            <>
              {config.run &&
                (running ? (
                  <>
                    <button onClick={startRun} title={config.run}>
                      ↻ Restart
                    </button>
                    <button className="danger" onClick={() => api.stopTerminal(run.id)}>
                      ■ Stop
                    </button>
                  </>
                ) : (
                  <button className="primary" onClick={startRun} title={config.run}>
                    ▶ Run
                  </button>
                ))}
              <button onClick={() => api.openPath(ws.path)}>Open folder</button>
              <button className="danger" onClick={props.onArchive}>
                Archive
              </button>
            </>
          )}
        </div>
      </header>

      <GitHubBar
        ws={ws}
        chats={props.chats}
        status={gh.status}
        error={gh.error}
        refresh={gh.refresh}
        onAskedClaude={() => setTab("chat")}
        onArchive={props.onArchive}
      />

      <details className="ws-info" open={ws.setup === "failed" || undefined}>
        <summary>
          Workspace · setup {{ none: "not configured", running: "running…", ok: "done", failed: "failed" }[ws.setup]}
        </summary>
        <dl className="facts">
          <dt>Path</dt>
          <dd>
            <code>{ws.path}</code>
          </dd>
          {ws.port && (
            <>
              <dt>Ports</dt>
              <dd>
                <code>{ws.port}</code>–<code>{ws.port + 9}</code> (<code>CABOOSE_PORT</code>)
              </dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{new Date(ws.createdAt).toLocaleString()}</dd>
        </dl>
        {log && <pre className="log">{log}</pre>}
      </details>

      <div className="view-tabs">
        <button className={tab === "chat" ? "active" : ""} onClick={() => setTab("chat")}>
          Chat
        </button>
        <button className={tab === "changes" ? "active" : ""} onClick={() => setTab("changes")}>
          Changes{fileCount > 0 && <span className="badge">{fileCount}</span>}
          {openComments > 0 && <span className="badge comments">💬{openComments}</span>}
        </button>
      </div>

      <ChatArea ws={ws} chats={props.chats} hidden={tab !== "chat"} />
      {tab === "changes" && (
        <ChangesView
          ws={ws}
          changes={diff.changes}
          error={diff.error}
          comments={props.comments}
          refresh={diff.refresh}
          onSendComments={async () => {
            const chat = activeChat(ws, props.chats);
            if (!chat) return;
            const r = await api.sendComments(ws.id, chat.id);
            if (r.ok) setTab("chat");
            else alert(r.error);
          }}
        />
      )}
      <TerminalPanel
        ws={ws}
        terminals={props.terminals}
        open={termOpen}
        setOpen={setTermOpen}
        activeId={termActive}
        setActiveId={setTermActive}
      />
    </div>
  );
}

function Empty({ hasRepos }: { hasRepos: boolean }) {
  return (
    <div className="empty">
      <div className="empty-icon">🚃</div>
      <h1>{hasRepos ? "Pick a workspace" : "All aboard"}</h1>
      <p className="muted">
        {hasRepos
          ? "Or press + next to a repository to start a new one."
          : "Add a git repository to start. Each workspace is its own worktree and branch."}
      </p>
    </div>
  );
}
