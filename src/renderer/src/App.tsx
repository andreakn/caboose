import { useEffect, useRef, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import type { DiffComment } from "../../shared/diff.ts";
import {
  type ArchivedFeature,
  type ConfigInfo,
  EMPTY_SIDEBAR,
  type Feature,
  type FeatureRepo,
  type PastPlatform,
  type RepoOverview,
  type RunSummary,
  type UpdateInfo,
  FEATURE_STATUSES,
  type FeatureJira,
  type JiraAlignment,
  type LogEntry,
  type Result,
  type State,
  type Terminal,
} from "../../shared/types.ts";
import { type Activity, activityOf, attentionOf, onActivityNotice, useActivityVersion } from "./activity.ts";
import { ChangesView, useFeatureChanges } from "./Changes.tsx";
import { activeChat, ChatArea } from "./Chat.tsx";
import { dispatch, useCommand } from "./commands.ts";
import { Configure } from "./Configure.tsx";
import { JiraChip, RepoRow } from "./GitHub.tsx";
import { ActivityView } from "./Activity.tsx";
import { MenuButton, OpenAppButton } from "./Menu.tsx";
import { allMerged, Board, HealthDot, JiraStatusChip, PrTiles, useOverview } from "./Overview.tsx";
import { DialogHost } from "./Dialog.tsx";
import { NewFeature } from "./NewFeature.tsx";
import { PlanView, StatusChip, useDocs } from "./Plan.tsx";
import { notificationsOn } from "./prefs.ts";
import { FilesView } from "./Files.tsx";
import { liveState, MapView, shippedAll } from "./Map.tsx";
import { ArchivedView } from "./Archived.tsx";
import { jiraBeforePrs } from "./jiraCheck.ts";
import { createPrsMessage, fixCiMessage } from "../../shared/github.ts";
import { TodoView } from "./Todos.tsx";
import { repoLabel, setRepoLabels } from "./labels.ts";
import { notifySound } from "./sounds.ts";
import { RetireDialog } from "./Retire.tsx";
import { featureOrder, normalize } from "../../shared/sidebar.ts";
import { deployProgress, repoDeploy, stageEmoji } from "../../shared/stages.ts";
import { FeatureTree } from "./Sidebar.tsx";
import { RunView, useRunOverview } from "./Run.tsx";
import { TerminalPanel, useTerminals } from "./Terminals.tsx";
import { lineConfig, linesOf, reposFor } from "../../shared/lines.ts";
import { stationLabel } from "../../shared/stations.ts";
import { NextPlatformDialog, PlatformStrip } from "./Platforms.tsx";

const api = window.caboose;

type Screen = "feature" | "configure" | "board" | "map" | "archived";

export function App() {
  const terminals = useTerminals();
  const runSummary = useRunSummary(terminals);
  const [state, setState] = useState<State>({ features: [], chats: [], comments: [], visits: [], sidebar: EMPTY_SIDEBAR });
  const [config, setConfig] = useState<ConfigInfo | null>(null);
  const [screen, setScreen] = useState<Screen>("feature");
  const [creating, setCreating] = useState(false);
  const [selected, setSelectedRaw] = useState<string | null>(() => localStorage.getItem("caboose-selected"));
  const select = (id: string) => {
    setSelectedRaw(id);
    localStorage.setItem("caboose-selected", id);
    setScreen("feature");
  };
  /** Opens a chat wherever it is: its feature, its repo's tab (or the feature's), its chat tab. */
  const openChatAnywhere = (featureId: string, chatId: string) => {
    select(featureId);
    setTimeout(() => dispatch(`openChat:${chatId}`), 50);
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retiring, setRetiring] = useState<Feature | null>(null);
  // Archived features, read from the archive folders; re-read when a feature ends or is continued.
  const [ended, setEnded] = useState<ArchivedFeature[]>([]);
  const [openEnded, setOpenEnded] = useState<string | null>(null);
  useEffect(() => void api.archivedFeatures().then(setEnded), [state.visits.length, state.features.length]);
  const showEnded = (folder: string) => {
    setOpenEnded(folder);
    setScreen("archived");
  };
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
      onActivityNotice(({ chatId, kind, what, body }) => {
        notifySound(kind);
        if (!notificationsOn() || document.hasFocus()) return;
        const s = stateRef.current;
        const chat = s.chats.find((c) => c.id === chatId);
        const f = chat && s.features.find((x) => x.id === chat.featureId);
        if (!chat || !f) return;
        const who = chat.agent === "copilot" ? "Copilot" : "Claude";
        // "Torup · shop: Claude asks", and in the body what it is about, not the chat's first message.
        const where = `${stationLabel(f.name)}${chat.repo ? ` · ${repoLabel(chat.repo)}` : ""}`;
        const happened = { question: `${who} asks`, approval: `${who} needs your approval`, done: `${who} is done`, stopped: `${who} stopped` }[what];
        const n = new Notification(`${where}: ${happened}`, { body, silent: kind === "done" });
        n.onclick = () => {
          api.focusWindow();
          openChatAnywhere(f.id, chat.id);
        };
      }),
    [],
  );

  // A feature reached a release stage (test, prod…): a notification and the "done" sound, even in the foreground.
  useEffect(
    () =>
      api.onReleaseNews((n) => {
        notifySound("done");
        if (!notificationsOn()) return;
        const what = `${stationLabel(n.station)}${n.title ? ` (${n.title})` : ""}`;
        const note = new Notification(`${what}: ${n.stage} ✓`, {
          body: n.running
            ? `It runs in ${n.stage} (${n.repos === 1 ? "its repo" : `all ${n.repos} repos`}).`
            : `${n.repos === 1 ? "Its repo is" : `All ${n.repos} repos are`} tagged for ${n.stage}.`,
          silent: true,
        });
        note.onclick = () => {
          api.focusWindow();
          if (stateRef.current.features.some((f) => f.id === n.featureId)) select(n.featureId);
        };
      }),
    [],
  );

  // Chats that want the user: waiting for an answer, or finished unseen (in live features only).
  const attention = state.chats.filter((c) => state.features.some((f) => f.id === c.featureId && !f.archived) && attentionOf(c.id));
  // Dock/taskbar badge: how many; the 🔔 in the sidebar says which.
  useEffect(() => {
    const count = attention.length;
    api.setBadge(count);
  }, [activityVersion, state.chats, state.features]);

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
  /** How many of a feature's chats want the user. */
  const wants = (f: Feature) => attention.filter((c) => c.featureId === f.id).length;

  useCommand((c) => {
    if (c === "settings" || c === "addRepo") setScreen((s) => (s === "configure" ? "feature" : "configure"));
    if (c === "newFeature") setCreating(true);
    if (c.startsWith("openFeature:")) select(c.slice("openFeature:".length));
    if ((c === "nextFeature" || c === "prevFeature") && live.length) {
      // In the order the sidebar shows them.
      const order = featureOrder(normalize(state.sidebar, live));
      const i = order.indexOf(feature?.id ?? "");
      select(order[(i + (c === "nextFeature" ? 1 : -1) + order.length) % order.length]);
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
        <div className="brand">
          <span>🚃 Caboose</span>
          <span className="spacer" />
          <button className={`brand-icon${screen === "map" ? " active" : ""}`} onClick={() => setScreen("map")} title="Map: every station a feature has been named after">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9 4 3 6.5v13.5L9 17.5l6 2.5 6-2.5V4l-6 2.5L9 4Z M9 4v13.5 M15 6.5V20" />
            </svg>
          </button>
          <button className={`brand-icon${screen === "board" ? " active" : ""}`} onClick={() => setScreen("board")} title="Board: every feature at a glance">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 4h7v7H4Z M13 4h7v7h-7Z M4 13h7v7H4Z M13 13h7v7h-7Z" />
            </svg>
          </button>
          <AttentionBell chats={attention} features={state.features} onOpen={(c) => openChatAnywhere(c.featureId, c.id)} />
        </div>
        <button className="new-feature" onClick={() => setCreating(true)}>
          + New feature
        </button>
        <section className="repo">
          <FeatureTree
            sidebar={state.sidebar}
            features={live}
            wants={wants}
            renderFeature={(f) => (
              <FeatureRow f={f} activity={activity(f)} run={runSummary[f.id]} wants={wants(f)} active={screen === "feature" && f.id === feature?.id} onClick={() => select(f.id)} />
            )}
          />
          {archived.length + ended.length > 0 && (
            <details className="archived">
              <summary>Archived ({archived.length + ended.length})</summary>
              {archived.map((f) => (
                <FeatureRow key={f.id} f={f} active={screen === "feature" && f.id === feature?.id} onClick={() => select(f.id)} />
              ))}
              {ended.map((a) => (
                <button
                  key={a.folder}
                  className={`ended-row${screen === "archived" && openEnded === a.folder ? " active" : ""}`}
                  onClick={() => showEnded(a.folder)}
                  title={`Archived ${a.archivedAt.slice(0, 10)}: read-only; Continue… carries it on`}
                >
                  <span className="hdot h-archived" />
                  <span className="ended-name">{stationLabel(a.name)}</span>
                  <span className="muted small ended-title">{a.title ?? a.repos.map((r) => repoLabel(r.name)).join(" · ")}</span>
                </button>
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
        {screen === "map" ? (
          <MapView
            features={state.features}
            visits={state.visits}
            home={config.config.home}
            onHome={(h) => void api.setHome(h).then(loadConfig)}
            onOpen={select}
            onOpenEnded={(id) => {
              const a = ended.find((x) => x.id === id);
              if (a) showEnded(a.folder);
            }}
          />
        ) : screen === "archived" && ended.some((a) => a.folder === openEnded) ? (
          <ArchivedView
            key={openEnded}
            a={ended.find((a) => a.folder === openEnded)!}
            config={config.config}
            continuedAs={state.features.find((f) => f.continuedFrom?.folder === openEnded)}
            onContinued={(f) => select(f.id)}
          />
        ) : screen === "board" ? (
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
            onRestore={() => act(`Restoring ${stationLabel(feature.name)}…`, () => api.restoreFeature(feature.id))}
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
            const what = mode === "archive" ? `Archived ${stationLabel(retiring.name)} to ${archivedTo}` : `Deleted ${stationLabel(retiring.name)}`;
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

/** Per feature, how many of its programs are running (refreshed when terminals change, and now and then). */
function useRunSummary(terminals: Terminal[]): Record<string, RunSummary> {
  const [summary, setSummary] = useState<Record<string, RunSummary>>({});
  const key = terminals.map((t) => `${t.id}:${t.exitCode ?? ""}`).join();
  useEffect(() => {
    const load = () => void api.runSummary().then(setSummary);
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [key]);
  return summary;
}

function FeatureRow(props: { f: Feature; activity?: Activity; run?: RunSummary; wants?: number; active: boolean; onClick: () => void }) {
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
        : ov && liveState(f, ov) === "busy"
          ? ["busy", "GitHub checks are running"]
        : a?.unread
          ? ["act-unread", "Done"]
          : [`setup-${setup}`, `Setup: ${setup}`];
  return (
    <button className={`ws-row${active ? " active" : ""}${f.archived ? " is-archived" : ""}`} onClick={onClick}>
      <span className={`dot ${cls}`} title={title} />
      <span className="ws-name">
        {stationLabel(f.name)}
        {f.status && f.status !== "active" && <span className={`status-mini st-${f.status}`}>{f.status}</span>}
        {(props.wants ?? 0) > 0 && (
          <span className={`wants-ind${a?.waiting ? " needs" : ""}`} title={`${props.wants} chat${props.wants === 1 ? "" : "s"} ${a?.waiting ? "need you or finished" : "finished while you were away"} (the 🔔 lists them)`}>
            {props.wants}
          </span>
        )}
        {props.run && props.run.running > 0 && (
          <span
            className={`run-ind${props.run.running >= props.run.total ? " full" : ""}`}
            title={`Running ${props.run.running} of ${props.run.total} programs (they hold their ports):\n${props.run.programs.join("\n")}`}
          >
            ▶ {props.run.running}/{props.run.total}
          </span>
        )}
        {ov && ov.todosOpen > 0 && (
          <span className="todo-ind" title={`${ov.todosOpen} step${ov.todosOpen === 1 ? "" : "s"} waiting for you (the To do tab)`}>
            ☐ {ov.todosOpen}
          </span>
        )}
      </span>
      <span className="ws-branch" title={f.repos.map((r) => repoLabel(r.name)).join(" · ")}>
        {f.title || f.repos.map((r) => repoLabel(r.name)).join(" · ") || "no repos"}
      </span>
      {(f.platforms ?? [])
        .filter((p) => !p.superseded && p.releases?.length && !shippedAll(platformRepos(p)))
        .map((p) => (
          <span key={p.n} className="platform-bars" title={`Platform ${p.n}${p.goal ? `: ${p.goal}` : ""}, still on its way`}>
            <span className="platform-bars-label">P{p.n}</span>
            <DeployBars repos={platformRepos(p)} />
          </span>
        ))}
      {ov && <DeployBars repos={ov.repos} />}
    </button>
  );
}

/** An earlier platform's merged repos, as overview repos for the deploy bars. */
const platformRepos = (p: PastPlatform): RepoOverview[] =>
  (p.releases ?? []).map((r) => ({ name: r.repo, branch: "", pr: { state: "MERGED" } as RepoOverview["pr"], stages: r.stages, release: r.release, ...(r.running ? { running: r.running } : {}), ...(r.components ? { components: r.components } : {}) }));

/**
 * How deployed a feature is: per environment (release stage), a segment per
 * repo with tag rules, filled once that repo is tagged for it. Shown once a
 * tracked repo has a PR.
 */
function DeployBars({ repos }: { repos: RepoOverview[] }) {
  if (!repos.some((r) => (r.stages?.length || r.running) && r.pr)) return null;
  const progress = deployProgress(repos);
  const state = (r: { tagged: boolean; running?: boolean }) =>
    r.running === true ? "✓ running" : r.running === false ? (r.tagged ? "… tagged, not running yet" : "– not running") : r.tagged ? "✓ tagged" : "–";
  return (
    <span className="deploy-bars">
      {progress.map((p, i) => (
        <span
          key={p.stage}
          className={`deploy-bar stage-${i}${p.done === p.total ? " complete" : ""}`}
          title={`${p.stage}: ${p.done} of ${p.total} repos there${p.pending ? ` (${p.pending} tagged, not running yet)` : ""}\n${p.repos.map((r) => `${state(r)} ${repoLabel(r.name)}`).join("\n")}`}
        >
          <span className="deploy-name">{p.stage}</span>
          <span className="deploy-segments">
            {p.repos.map((r) => (
              <span key={r.name} className={r.done ? "seg done" : r.tagged ? "seg pending" : "seg"} />
            ))}
          </span>
          {p.total > 1 && (
            <span className="deploy-count">
              {p.done}/{p.total}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

type FeatureTab = "chat" | "plan" | "todo" | "run" | "prs" | "activity";
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
  const own = lineConfig(config.config, f.line);
  const level = own.jira?.level ?? "off";
  const site = own.jira?.site;

  const [jira, setJira] = useState<FeatureJira>({ subtasks: {} });
  const [nextPlatform, setNextPlatform] = useState(false);
  const loadJira = () => api.featureJira(f.id).then(setJira);
  // Again whenever the overview refreshes: an agent may have linked an issue (LinkJira).
  useEffect(() => void loadJira(), [f.id, overview.ov]);

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
    if (c.startsWith("openChat:")) {
      const chat = props.chats.find((x) => x.id === c.slice("openChat:".length));
      if (!chat) return;
      if (chat.repo && f.repos.some((r) => r.name === chat.repo)) openRepo(chat.repo, "chat");
      else {
        setScope("feature");
        setTab("chat");
      }
      setTimeout(() => dispatch(`selectChat:${chat.id}`), 50);
    }
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

  const lines = linesOf(config.config.repos ?? []);
  const missing = reposFor(config.config.repos ?? [], f.line).filter((r) => !f.repos.some((x) => x.name === r.name));
  // Repos on GitHub with work and no PR yet (none, or only a closed one): what "Create PRs" covers.
  const prReady = f.repos.filter((r) => {
    const o = overview.ov?.repos.find((x) => x.name === r.name);
    const changes = Boolean(o?.local && (o.local.uncommitted > 0 || o.local.aheadBase > 0));
    // pr: null = on GitHub without a PR; undefined = not on GitHub (or not known yet).
    return changes && (o?.pr === null || o?.pr?.state === "CLOSED");
  });
  // Every repo still without a PR has reported "ready" (its work committed): time to open them, from the header.
  const noPrYet = f.repos.filter((r) => {
    const pr = overview.ov?.repos.find((x) => x.name === r.name)?.pr;
    return !pr || pr.state === "CLOSED";
  });
  const allReady = noPrYet.length > 0 && noPrYet.every((r) => reported[r.name]?.status === "ready" && prReady.includes(r));
  // Repos whose PR fails CI: what the header's "Fix CI" covers.
  const failingCi = (overview.ov?.repos ?? []).filter((r) => r.pr && (r.pr.state === "OPEN" || r.pr.state === "DRAFT") && r.pr.checks.state === "failing");
  /** One message to the feature's chat: find out why CI fails in each, fix it (or re-run what is flaky). */
  const fixCi = async () => {
    let chat = props.chats.filter((c) => !c.repo).at(-1);
    if (!chat) {
      const made = await api.createChat(f.id);
      if (!made.ok) return alert(made.error);
      chat = made.value;
    }
    const r = await api.send(chat.id, fixCiMessage(failingCi.map((x) => ({ repo: x.name, pr: x.pr!.number, checks: x.pr!.checks.failed }))));
    if (!r.ok) return alert(r.error);
    openChat(chat.id);
  };
  /** One message to the feature's chat, which works across every repo. */
  const createPrs = async (draft: boolean, picked = prReady) => {
    // No Jira issue for the branches: offer to create the task and subtasks first.
    const connected = Boolean(own.jira?.site && own.jira?.email && own.jira?.hasToken);
    const fresh = await jiraBeforePrs(f, picked, level, connected);
    if (!fresh) return;
    void loadJira();
    const keyOf = (repo: string) => fresh.subtasks[repo] ?? fresh.task;
    // Branches may have been renamed to carry their keys.
    const now = (await api.getState()).features.find((x) => x.id === f.id) ?? f;
    const repos = picked.map((r) => now.repos.find((x) => x.name === r.name) ?? r);
    let chat = props.chats.filter((c) => !c.repo).at(-1);
    if (!chat) {
      const made = await api.createChat(f.id);
      if (!made.ok) return alert(made.error);
      chat = made.value;
    }
    const message = createPrsMessage(
      repos.map((r) => ({ repo: r.name, branch: r.branch, baseRef: r.baseRef, ...(keyOf(r.name) ? { jiraKey: keyOf(r.name) } : {}) })),
      draft,
      own.prInstructions,
    );
    const r = await api.send(chat.id, message);
    if (!r.ok) return alert(r.error);
    openChat(chat.id);
  };
  const repoRow = (r: FeatureRepo, inline = false) => (
    <RepoRow
      key={r.name}
      inline={inline}
      feature={f}
      repo={r}
      chats={props.chats}
      jiraLevel={level}
      jiraKey={jira.subtasks[r.name] ?? jira.task}
      subtask={jira.subtasks[r.name]}
      hasTask={Boolean(jira.task)}
      jiraSite={site}
      prInstructions={own.prInstructions}
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
            <span title={f.name === stationLabel(f.name) ? undefined : `${f.name} (folder and branch name)`}>{stationLabel(f.name)}</span>{" "}
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
            {lines.length > 0 && (
              <select
                className={`line-chip${f.line ? "" : " none"}`}
                value={f.line ?? ""}
                disabled={f.archived}
                title="The line this feature runs on: only repos on it (or on no line) can join"
                onChange={async (e) => {
                  const r = await api.setFeatureDetails(f.id, { line: e.target.value || null });
                  if (!r.ok) alert(r.error);
                }}
              >
                <option value="">any line</option>
                {[...new Set([...lines, ...(f.line ? [f.line] : [])])].map((l) => (
                  <option key={l} value={l}>
                    {l} line
                  </option>
                ))}
              </select>
            )}
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
            <FeatureTitle f={f} />
            <PlatformStrip f={f} ov={overview.ov} onNext={() => setNextPlatform(true)} />
          </h1>
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
              {failingCi.length > 0 && (
                <button
                  className="fix-ci"
                  onClick={() => void fixCi()}
                  title={`CI fails in ${failingCi.map((r) => repoLabel(r.name)).join(", ")}: ask the feature's chat to find out why and fix it`}
                >
                  Fix CI ({failingCi.length})
                </button>
              )}
              {allReady && (
                <span className="split-button" title={`Every repo reported ready: ask the feature's chat to open a PR for ${noPrYet.map((r) => repoLabel(r.name)).join(", ")}`}>
                  <button className="primary open-prs" onClick={() => void createPrs(false, noPrYet)}>
                    Open PRs ({noPrYet.length})
                  </button>
                  <MenuButton
                    className="primary open-prs-more"
                    label="▾"
                    title="Other ways to open them"
                    align="right"
                    items={[
                      { label: "Open PRs", onClick: () => void createPrs(false, noPrYet) },
                      { label: "Open draft PRs", onClick: () => void createPrs(true, noPrYet) },
                    ]}
                  />
                </span>
              )}
              <button className="primary" onClick={() => setTab("run")} title="The Run tab: start and stop each repo's programs (Cmd/Ctrl+R runs them all)">
                ▶ Run{running > 0 ? ` (${running})` : ""}
              </button>
              <OpenAppButton path={f.folder} what="the feature folder" />
              <FeatureInfo f={f} />
              <button className="danger" onClick={props.onArchive} title="Archive or delete the feature: closes its open PRs and deletes its branches">
                Archive…
              </button>
            </>
          )}
        </div>
      </header>

      {!f.archived && allMerged(overview.ov) && (
        <MergedOffer f={f} prs={overview.ov!.repos.map((r) => r.pr!.number)} onArchive={props.onArchive} onNextPlatform={() => setNextPlatform(true)} />
      )}
      {nextPlatform && (
        <NextPlatformDialog
          f={f}
          ov={overview.ov}
          hasTask={Boolean(jira.task) && level !== "off"}
          onCancel={() => setNextPlatform(false)}
          onDone={() => {
            setNextPlatform(false);
            void loadJira();
            void overview.reload();
          }}
        />
      )}

      <NeedsYou f={f} chats={props.chats} reported={reported} onOpenChat={(id) => dispatch(`openChat:${id}`)} />

      <div className="scope-tabs">
        <button
          className={scopeRepo ? "" : "active"}
          onClick={() => setScope("feature")}
          title="What the repos share: the central chat, the plan, every program, the PRs, all activity"
        >
          Feature
          <AttentionDot chats={props.chats.filter((c) => !c.repo || !f.repos.some((r) => r.name === c.repo))} />
        </button>
        {f.repos.map((r) => {
          const n = diff.byRepo[r.name]?.files.length ?? 0;
          const rov = overview.ov?.repos.find((x) => x.name === r.name);
          return (
            <button key={r.name} className={scopeRepo?.name === r.name ? "active" : ""} onClick={() => setScope(r.name)} title={r.path}>
              {rov && <HealthDot r={rov} />}
              {repoLabel(r.name)}
              <AttentionDot chats={props.chats.filter((c) => c.repo === r.name)} />
              {rov?.pr &&
                (() => {
                  const pr = rov.pr;
                  const label = (
                    <>
                      #{pr.number}
                      {{ passing: "✓", failing: "✗", pending: "●", none: "" }[pr.checks.state]}
                    </>
                  );
                  // On the open tab the PR is a link to GitHub; on the others a click just opens the tab.
                  return scopeRepo?.name === r.name ? (
                    <a
                      href={pr.url}
                      className={`tab-pr link pr-${pr.state.toLowerCase()}`}
                      title={`Open PR #${pr.number} on GitHub: ${pr.title}`}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void api.openUrl(pr.url);
                      }}
                    >
                      {label}
                    </a>
                  ) : (
                    <span className={`tab-pr pr-${pr.state.toLowerCase()}`} title={`PR #${pr.number}: ${pr.title}`}>
                      {label}
                    </span>
                  );
                })()}
              {rov &&
                (() => {
                  // How far its change has shipped: 🏷 release tagged, 🧪 in test, 🚀 in prod.
                  const d = repoDeploy(rov);
                  return d.reached ? (
                    <span className="tab-deploy" title={`Shipped as far as ${d.reached}:\n${d.lines.join("\n")}`}>
                      {stageEmoji(d.reached)}
                    </span>
                  ) : null;
                })()}
              {/* Once merged, the count of changed files says nothing new: the deploy mark takes its place. */}
              {n > 0 && rov?.pr?.state !== "MERGED" && (
                <span className="badge" title={`${n} changed file(s)`}>
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className={`scope-panel ${scopeRepo ? "in-repo" : "in-feature"}`}>
        {scopeRepo ? (
          <>
            {/* The repo's state and actions on their own line, so the tab row stays tabs. */}
            <div className="repo-statusline">{repoRow(scopeRepo, true)}</div>
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
              <OpenAppButton path={scopeRepo.path} what={repoLabel(scopeRepo.name)} />
            </div>
            <div className="view-panel">
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
            </div>
          </>
        ) : (
          <>
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
              <button className={tab === "todo" ? "active" : ""} onClick={() => setTab("todo")} title="Steps for you to do by hand (migrations, secrets, settings)">
                To do
                {docs && docs.todos.some((t) => !t.done) && <span className="badge todo-badge">{docs.todos.filter((t) => !t.done).length}</span>}
              </button>
              <button className={tab === "run" ? "active" : ""} onClick={() => setTab("run")}>
                Run{running > 0 && <span className="badge ok">{running}</span>}
              </button>
              <button className={tab === "prs" ? "active" : ""} onClick={() => setTab("prs")} title="Every repo: its branch, PR, Jira and what to do next">
                Repos
                {(() => {
                  const n = overview.ov?.repos.filter((r) => r.pr && (r.pr.state === "OPEN" || r.pr.state === "DRAFT")).length ?? 0;
                  return n > 0 ? <span className="badge">{n}</span> : null;
                })()}
              </button>
              <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>
                Activity
              </button>
            </div>

            <div className="view-panel">
              <ChatArea ws={f} chats={props.chats} hidden={tab !== "chat"} />
              {tab === "plan" && <PlanView f={f} docs={docs} reload={() => void reloadDocs()} />}
              {tab === "todo" && (
                <TodoView f={f} docs={docs} chats={props.chats} reload={() => void reloadDocs()} onTold={(c) => (c.repo ? showChat(c.repo) : openChat(c.id))} />
              )}
              {tab === "run" && <RunView f={f} ov={runs.ov} reload={runs.reload} onShow={showTerminal} />}
              {tab === "prs" && (
                <div className="plan-view">
                  <PrTiles
                    ov={overview.ov}
                    loading={overview.loading}
                    refresh={() => void overview.refresh()}
                    featureId={f.archived ? undefined : f.id}
                    extra={!f.archived && prReady.length > 0 && (
                      <MenuButton
                        className="create-prs"
                        label={`Create PRs (${prReady.length}) ▾`}
                        title={`Ask the feature's chat to commit, push and open a PR for: ${prReady.map((r) => repoLabel(r.name)).join(", ")}`}
                        items={[
                          { label: `Create PRs for ${prReady.map((r) => repoLabel(r.name)).join(", ")}`, onClick: () => void createPrs(false) },
                          { label: "Create them as drafts", onClick: () => void createPrs(true) },
                        ]}
                      />
                    )}
                  />
                <div className="repos">
                  {f.repos.map((r) => repoRow(r))}
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
                </div>
              )}
              {tab === "activity" && <ActivityView f={f} chats={props.chats} onOpenChat={openChat} />}
            </div>
          </>
        )}
      </div>
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

/** ⓘ in the header: folder, ports, setup and copied files per repo, created. */
function FeatureInfo({ f }: { f: Feature }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-wrap">
      <button className={open ? "active" : ""} title="Feature details: folder, ports, setup" onClick={() => setOpen(!open)}>
        ⓘ
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="popover info-popover">
            <div className="muted small">
              Ports {f.port}–{f.port + 99}
            </div>
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
          </div>
        </>
      )}
    </span>
  );
}

/** Every branch is merged: offer to archive (once per set of PRs; "Not now" hides it until another PR is merged). */
function MergedOffer({ f, prs, onArchive, onNextPlatform }: { f: Feature; prs: number[]; onArchive: () => void; onNextPlatform: () => void }) {
  const key = `caboose-merged-offer-${f.id}`;
  const value = [...prs].sort((a, b) => a - b).join(",");
  const [hidden, setHidden] = useState(() => localStorage.getItem(key) === value);
  if (hidden) return null;
  return (
    <div className="merged-offer">
      <span className="hdot h-merged" />
      <span>
        {f.repos.length === 1 ? "Its branch is merged." : `All ${f.repos.length} branches are merged.`} Archive the feature, or go on with a next platform?
        <span className="muted"> Its releases are still followed either way.</span>
      </span>
      <span className="spacer" />
      <button onClick={onNextPlatform} title="A new wave of this feature: new branches, the same chats, log and plan">
        Next platform…
      </button>
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

/** A tab's chats that want the user: a count, red when one is waiting for an answer. */
function AttentionDot({ chats }: { chats: Chat[] }) {
  useActivityVersion();
  const states = chats.map((c) => attentionOf(c.id)).filter(Boolean);
  if (!states.length) return null;
  const needs = states.includes("needs");
  return (
    <span
      className={`wants-dot${needs ? " needs" : ""}`}
      title={needs ? "A chat here needs you" : `${states.length === 1 ? "A chat here" : `${states.length} chats here`} finished while you were away`}
    />
  );
}

/** 🔔 n in the sidebar: which chats want the user, in which feature and repo; a click opens the chat. */
function AttentionBell({ chats, features, onOpen }: { chats: Chat[]; features: Feature[]; onOpen: (c: Chat) => void }) {
  const [open, setOpen] = useState(false);
  if (!chats.length) return null;
  const needs = chats.filter((c) => attentionOf(c.id) === "needs");
  const done = chats.filter((c) => attentionOf(c.id) === "done");
  const row = (c: Chat, what: string) => {
    const f = features.find((x) => x.id === c.featureId);
    return (
      <button
        key={c.id}
        className="bell-row"
        onClick={() => {
          setOpen(false);
          onOpen(c);
        }}
      >
        <b>{f ? stationLabel(f.name) : "?"}</b>
        <span>{c.repo ? `${repoLabel(c.repo)}'s chat` : c.title === "New chat" ? "feature chat" : c.title}</span>
        <span className="muted small">{what}</span>
      </button>
    );
  };
  return (
    <span className="info-wrap">
      <button className={`brand-icon bell${needs.length ? " needs" : ""}`} onClick={() => setOpen(!open)} title={`${chats.length} chat${chats.length === 1 ? "" : "s"} want you: which ones`}>
        🔔<span className="bell-count">{chats.length}</span>
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="popover bell-popover">
            {needs.map((c) => row(c, "needs your answer"))}
            {done.map((c) => row(c, "finished while you were away"))}
          </div>
        </>
      )}
    </span>
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
    <span className={`feature-title${f.title ? "" : " empty"}`} onClick={() => !f.archived && setEditing(true)} title={f.folder}>
      {f.title ? f.title : f.archived ? "" : "+ add a title"}
    </span>
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
