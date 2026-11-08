// Shapes shared by the main process, the preload bridge and the renderer.
import type { Agent, Chat, ChatEvent, Effort, Mode, Model, ModelOption } from "./chat.ts";
import type { DiffComment, WorkspaceChanges } from "./diff.ts";
import type { GitHubStatus, MergeMethod, MergeOutcome, PrDetails } from "./github.ts";

export type SetupState = "none" | "running" | "ok" | "failed";

/** A repo's scripts: setup when a worktree is made, named run scripts, archive before it is removed. */
export type RepoScripts = {
  setup?: string;
  archive?: string;
  run?: { name: string; command: string }[];
};

/** A release stage: a name and the tag pattern (glob) that marks it, e.g. test = *_TEST_v*. */
export type ReleaseStage = { name: string; pattern: string };
/** The lowest tags of one stage that carry a change (one per tag prefix, for repos with several services). */
export type StageRelease = { stage: string; tags: string[] };

/** A repo the user works in, from the config: its name is also its folder name inside a feature. */
export type RepoEntry = {
  name: string;
  /** A friendly name shown instead of `name` (tabs, rows); `name` stays the id and folder name. */
  label?: string;
  /** The line it is on (a customer's repos, your own…): features never mix lines. None = it serves every line. */
  line?: string;
  /** Release tag stages for this repo, instead of the config's `releaseStages`; [] = do not track. */
  releaseStages?: ReleaseStage[];
  path: string;
  scripts?: RepoScripts;
  /**
   * Gitignored files to copy from the main checkout into each new worktree
   * (.env, *.local.*, …), as gitignore-style patterns. Absent: the defaults.
   */
  localFiles?: string[];
};

/** One repo's worktree inside a feature. */
export type FeatureRepo = {
  /** The repo's name (folder name in the feature). */
  name: string;
  /** The main checkout the worktree was made from. */
  source: string;
  /** Absolute path to the worktree: <feature folder>/<name>. */
  path: string;
  branch: string;
  /** What the branch started from, e.g. "origin/main". */
  baseRef: string;
  setup: SetupState;
  /** The local files copied in from the main checkout (repo-relative paths). */
  copied?: string[];
};

export type FeatureStatus = "planning" | "active" | "review" | "done" | "paused";
export const FEATURE_STATUSES: FeatureStatus[] = ["planning", "active", "review", "done", "paused"];

/** A piece of work: a station name, a folder, and one worktree per repo. */
export type Feature = {
  id: string;
  /** The station name, also the folder name. */
  name: string;
  /** What it is about, in words (optional; the station name is the id). */
  title?: string;
  /** Absent = active. */
  status?: FeatureStatus;
  /** Absolute path to the feature's folder. */
  folder: string;
  createdAt: string;
  archived: boolean;
  /** First of the feature's 100 ports; repo i gets port + 10·i as CABOOSE_PORT. */
  port: number;
  repos: FeatureRepo[];
  /** The line it runs on: only repos on it (or on none) can join. Taken from its first repo on a line, if not chosen. */
  line?: string;
};

export type Terminal = {
  id: string;
  featureId: string;
  /** The repo it was opened in; none = the feature folder. */
  repo?: string;
  kind: "shell" | "run";
  /** Which run script it runs: the file name (run_orders.sh), or config:<name>. */
  script?: string;
  title: string;
  startedAt: string;
  /** Set once the process has exited. */
  exitCode?: number;
};

/** A file for the Files tab. */
export type FileContent =
  | { kind: "text"; size: number; text: string }
  | { kind: "image"; size: number; dataUrl: string }
  | { kind: "binary"; size: number }
  | { kind: "tooLarge"; size: number };

/** What archiving or deleting a feature will do to one repo. */
export type RetireRepo = {
  repo: string;
  branch: string;
  /** Its PR; an open or draft one is closed. */
  pr?: { number: number; state: string; url: string; title: string };
  /** Why the PR could not be looked up (it is then not closed). */
  prError?: string;
  /** Lost with the worktree. */
  uncommitted: number;
  /** Commits that are on no remote branch: lost with the branch. */
  unpushed: number;
  /** Set when the branch is kept (it is a main branch). */
  keepBranch?: string;
};

export type RetirePlan = { feature: string; title?: string; archiveTo: string; repos: RetireRepo[] };

/** Archive: PRs closed, branches deleted, folder and chat logs moved to the archive. Delete: the same, but the folder and logs are deleted. */
export type RetireMode = "archive" | "delete";
export type RetireOutcome = {
  archivedTo?: string;
  closedPrs: number[];
  deletedBranches: string[];
  warnings: string[];
  /** Every repo's PR had been merged (the feature was finished, not abandoned). */
  merged: boolean;
};

/** A URL a run script declares (`# url: http://localhost:5173/ app`). */
export type RunUrl = { url: string; label?: string };

/** running: in its terminal; exited: ended by itself, its terminal still open; stopped: no terminal. */
export type RunState = "running" | "exited" | "stopped";

/** A program holding a port: one outside the Run tab (stray), or whatever holds a port a script wants. */
export type PortHolder = {
  pid: number;
  name: string;
  ports: number[];
  command: string;
  /** Where it runs from: "oslo/web", "web (main checkout)", "oslo: run web"; absent = somewhere Caboose does not know. */
  where?: string;
  /** Caboose may stop it: it runs from a feature or a configured repo, or in one of Caboose's terminals. */
  stoppable: boolean;
};

export type RunScript = {
  /** The file name (run_orders.sh), or config:<name>. */
  id: string;
  /** The moniker (orders), "run" for run.sh, or the configured name. */
  label: string;
  /** From the moniker file. */
  description?: string;
  command: string;
  urls: RunUrl[];
  state: RunState;
  terminalId?: string;
  exitCode?: number;
  /** While it is not running: what already listens on a port its URLs use. */
  busy?: PortHolder[];
  /** The same program (repo and script) running in other features: it likely holds the port this one needs. */
  elsewhere?: { featureId: string; feature: string }[];
};

/** A feature's programs at a glance, for the sidebar. */
export type RunSummary = { running: number; total: number; programs: string[] };

export type RunRepo = {
  repo: string;
  path: string;
  moniker?: string;
  description?: string;
  scripts: RunScript[];
  /** Programs listening from this worktree that the Run tab did not start. */
  strays: PortHolder[];
};

export type RunOverview = {
  repos: RunRepo[];
  /** Why programs outside the Run tab cannot be seen (lsof/ss/PowerShell missing). */
  strayError?: string;
};

/** A merged repo of an ended feature, with what is needed to keep reading its release tags. */
export type VisitRelease = { repo: string; source: string; mergeCommit: string; stages: string[]; release: StageRelease[] };

/** A feature that ended (archived or deleted), kept for the map. */
export type StationVisit = {
  /** The feature's name: a station id, maybe with "-2". */
  station: string;
  featureId: string;
  title?: string;
  repos: string[];
  createdAt: string;
  endedAt: string;
  ended: "archived" | "deleted";
  /** Every repo's PR was merged when it ended. */
  merged: boolean;
  /** Its merged repos' releases, still followed after it ended. */
  releases?: VisitRelease[];
};

/** The sidebar's folders and the order of everything in it. */
export type Sidebar = {
  folders: { id: string; name: string }[];
  /** What each folder ("root" for the top level) holds, in order: "f:<feature id>" or "d:<folder id>". */
  children: Record<string, string[]>;
  /** Folders shown closed. */
  collapsed: string[];
};

export const EMPTY_SIDEBAR: Sidebar = { folders: [], children: {}, collapsed: [] };

export type State = {
  features: Feature[];
  chats: Chat[];
  comments: DiffComment[];
  /** Features that have ended, newest last. */
  visits: StationVisit[];
  sidebar: Sidebar;
  /** "<feature id>:<stage>" for every feature that reached a stage and was announced. */
  releaseNews?: string[];
};

/** Per-repo settings, read from `caboose.json` in the repo's main checkout. */
export type RepoConfig = {
  /** Shell command run in a new worktree (e.g. "npm install"). */
  setup?: string;
  /** Shell command for the Run button. */
  run?: string;
  /** Shell command run before a worktree is removed. */
  archive?: string;
  /** More local-file patterns (like RepoEntry.localFiles), kept in the repo itself. */
  copy?: string[];
};

/** How strongly features must be tied to Jira. */
export type JiraLevel = "off" | "optional" | "expected" | "required";
export const JIRA_LEVELS: { value: JiraLevel; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "No Jira anywhere." },
  { value: "optional", label: "Optional", hint: "A feature can link a Jira task, and each repo a subtask." },
  { value: "expected", label: "Expected", hint: "New features ask for a task (you can skip); PRs warn without one." },
  { value: "required", label: "Required", hint: "Every feature needs a task; each repo gets a subtask, created if missing." },
];

/** A secret in the config file: encrypted with the OS keychain, or plain where there is none. */
export type Secret = { enc: string } | { plain: string };

export type JiraConfig = {
  level: JiraLevel;
  /** e.g. https://yourcompany.atlassian.net */
  site?: string;
  email?: string;
  token?: Secret;
  /** Project key for new tasks, e.g. ABC. */
  project?: string;
};

/** This machine's settings, in `caboose.local.json` in the Caboose checkout (gitignored). */
export type LocalConfig = {
  /** Where feature folders go. Default: ~/caboose/features */
  featuresRoot?: string;
  /** Where archived features go (folder, docs and chat logs). Default: ~/caboose/archive */
  archiveRoot?: string;
  /** Branch prefix. Default: "caboose". */
  branchPrefix?: string;
  repos?: RepoEntry[];
  jira?: JiraConfig;
  /** Path to bash for repo scripts. Default: bash on PATH, or Git for Windows' bash. */
  bashPath?: string;
  /** Shell for terminals. Default: $SHELL on macOS/Linux, PowerShell on Windows. */
  shellPath?: string;
  /** Font for terminals, e.g. a Nerd Font your prompt needs. Default: common Nerd/Powerline fonts, then monospace. */
  terminalFont?: string;
  /** Which agent new chats use unless you pick another: Claude Code or GitHub Copilot. */
  defaultAgent?: Agent;
  /** The permission mode new chats start in. Default: bypass (like Conductor). */
  defaultMode?: Mode;
  /** Release tag stages for every repo (optional): which tag marks a release, a test deploy, a prod deploy… */
  releaseStages?: ReleaseStage[];
  /** A moniker file (moniker, path, description per line) that names and describes repos and their run_<moniker>.sh scripts. */
  monikersFile?: string;
  /** How PRs should be written (title, description style); added to Create PR requests to the agent. */
  prInstructions?: string;
  /** Commands to open a folder in an app, overriding detection; "{path}" is replaced. */
  openWith?: Partial<Record<AppId, string>>;
  /** Where new features' stations are picked from first, spreading outwards (picked on the map). */
  home?: HomeArea;
};

/** A point on the map (degrees), around which feature names are picked. */
export type HomeArea = { lon: number; lat: number };

/** Apps a folder can be opened in. */
export type AppId = "vscode" | "rider" | "visualStudio" | "terminal" | "files";
export type AppInfo = { id: AppId; label: string; /** The app's own icon, as a data URL (macOS and Windows). */ icon?: string };

/** A repo offered for import from Conductor, with what was found for it. */
export type ImportCandidate = RepoEntry & {
  exists: boolean;
  /** Where its local-file rules came from (".worktreeinclude", ".conductor/settings.local.toml", …). */
  rulesFrom: string;
  alreadyConfigured: boolean;
};

export type ConductorImport = {
  available: boolean;
  repos: ImportCandidate[];
  /** Conductor's global "create PR" prompt, if any. */
  prInstructions?: string;
};

/** The config as the window sees it: the token is never sent, only whether there is one. */
export type ConfigView = Omit<LocalConfig, "jira"> & { jira?: Omit<JiraConfig, "token"> & { hasToken: boolean } };
/** What the window saves: `token` is a new token to store, null to remove it, absent to keep it. */
export type ConfigInput = Omit<LocalConfig, "jira"> & { jira?: Omit<JiraConfig, "token"> & { token?: string | null } };

export type ConfigInfo = {
  config: ConfigView;
  /** With defaults filled in. */
  defaults: { featuresRoot: string; archiveRoot: string; branchPrefix: string; localFiles: string[] };
  /** No config file yet: show the setup screen. */
  firstRun: boolean;
  file: string;
  dataDir: string;
  /** Whether secrets can be encrypted on this machine (false on Linux without a keyring). */
  canEncrypt: boolean;
};

/** An issue's status for the overview. Category: new (to do), indeterminate (in progress), done. */
export type JiraStatus = { key: string; summary: string; status: string; category: "new" | "indeterminate" | "done"; assignee?: string; url: string };

/** One repo in the overview. `pr`: undefined = unknown (no GitHub), null = none on the branch. */
export type RepoOverview = {
  name: string;
  branch: string;
  reported?: LogEntry;
  local?: { uncommitted: number; ahead: number; behindBase: number; pushed: boolean };
  pr?: PrDetails | null;
  jira?: JiraStatus | { key: string };
  /** Once merged: the lowest tags per release stage that contain the merge commit. */
  release?: StageRelease[];
  /** The release stages this repo is tracked for (its tag rules); none = it does not count. */
  stages?: string[];
};

/** A feature at a glance: what the board and the feature page show. */
export type FeatureOverview = {
  id: string;
  progress: { done: number; total: number };
  task?: JiraStatus | { key: string };
  repos: RepoOverview[];
  errors: string[];
};

export type JiraIssue = { key: string; summary: string; status: string; type: string; url: string; subtasks?: { key: string; summary: string }[] };

/** What a repo's agent last reported about its work. */
export type RepoStatus = "queued" | "working" | "blocked" | "needs-input" | "ready" | "in-review" | "done";
export const REPO_STATUSES: RepoStatus[] = ["queued", "working", "blocked", "needs-input", "ready", "in-review", "done"];

export type PlanTask = { line: number; done: boolean; text: string; depth: number };
export type LogEntry = { at: string; from: string; to?: string; status?: RepoStatus; text: string };

/** The feature's working documents (plain files in its folder). */
export type FeatureDocs = {
  brief: string;
  plan: string;
  tasks: PlanTask[];
  progress: { done: number; total: number };
  repoBriefs: Record<string, string>;
  log: LogEntry[];
};

/** What linking Jira changed: subtasks created and branches renamed to carry their keys. */
export type JiraAlignment = { created: string[]; renamed: { repo: string; from: string; to: string }[]; skipped: string[] };

/** The Jira links of a feature, as written in its jira.txt. */
export type FeatureJira = { task?: string; subtasks: Record<string, string> };

/** What can be changed about a feature after it is made. `line: null` takes it off its line. */
export type FeatureDetails = { title?: string; status?: FeatureStatus; line?: string | null };

export type NewFeature = {
  /** Repos to add right away (none = an empty feature, built out later). */
  repos?: string[];
  /** The line it runs on (none: any, until a repo on a line joins). */
  line?: string;
  title?: string;
  /** What the user wants, in their words: sent to the feature's central chat, which proposes the repos. */
  text?: string;
  /** Which agent the feature's first chat uses (default: the main agent). */
  agent?: Agent;
  /** An existing task key, or the summary of a task to create in the configured project. */
  jira?: { key: string } | { create: string };
};

export type DoctorCheck = { name: string; ok: boolean; detail: string; hint?: string; optional?: boolean };

/** Whether each agent can run here (logged in), for choosing the main agent. */
export type AgentLogins = Record<Agent, { ok: boolean; detail: string }>;

export type UpdateInfo = {
  branch: string;
  commit: string;
  behind: number;
  ahead: number;
  dirty: boolean;
  /** "abc1234 subject" for each commit an update would bring. */
  commits: string[];
  note?: string;
  /** The commit the running app was started from. */
  running?: string;
  /** Commits the checkout already has that the running app does not (pulled or committed since it started): a restart brings them. */
  newer: string[];
};

export type Theme = "system" | "light" | "dark";

export type MenuCommand =
  | "settings"
  | "newFeature"
  | "newChat"
  | "newTerminal"
  | "addRepo"
  | "showChat"
  | "showChanges"
  | "toggleTerminal"
  | "focusComposer"
  | "nextChat"
  | "prevChat"
  | "run"
  | "stopClaude"
  | "nextFeature"
  | "prevFeature";

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** What the preload script exposes as `window.caboose`. */
export type CabooseApi = {
  getState(): Promise<State>;
  onStateChanged(listener: (state: State) => void): () => void;

  config(): Promise<ConfigInfo>;
  saveConfig(config: ConfigInput): Promise<Result<void>>;
  /** Sets (or with null, clears) the home area alone, from the map. */
  setHome(home: HomeArea | null): Promise<Result<void>>;
  pickFolder(title: string): Promise<string | null>;
  /** A repo's top folder and name, if `path` is inside a git repo. */
  checkRepo(path: string): Promise<Result<RepoEntry>>;
  /** Git repos directly inside a folder (e.g. ~/code). */
  scanRepos(folder: string): Promise<RepoEntry[]>;

  jiraTest(): Promise<Result<string>>;
  jiraIssue(key: string): Promise<Result<JiraIssue>>;
  jiraMyIssues(): Promise<Result<JiraIssue[]>>;
  featureJira(featureId: string): Promise<FeatureJira>;
  /** Links (or unlinks) the feature's task; linking adds subtasks and puts their keys in unpushed branches. */
  setFeatureTask(featureId: string, key: string | null): Promise<Result<JiraAlignment>>;
  /** A feature reached a release stage (every tracked repo tagged for it). */
  onReleaseNews(listener: (news: { featureId: string; station: string; title?: string; stage: string; repos: number }) => void): () => void;
  /** Saves the sidebar's folders and order. */
  saveSidebar(sidebar: Sidebar): Promise<void>;
  setFeatureDetails(featureId: string, details: FeatureDetails): Promise<Result<void>>;
  /** The configured repos this feature can add (its line's and those on no line), by name. */
  addableRepos(featureId: string): Promise<string[]>;
  /** The repo's scripts: from the config, plus its own caboose.json. */
  repoScripts(featureId: string, repo: string): Promise<RepoScripts>;
  conductorImport(): Promise<Result<ConductorImport>>;
  /** Local-file rules a repo itself declares (.worktreeinclude, .conductor/*.toml), if any. */
  repoRules(repoPath: string): Promise<{ patterns: string[]; from: string } | null>;
  apps(): Promise<AppInfo[]>;
  openIn(app: AppId, path: string): Promise<Result<void>>;
  setRepoSubtask(featureId: string, repo: string, key: string | null): Promise<Result<void>>;
  /** The files these patterns would copy from a repo's main checkout. */
  previewLocalFiles(repoPath: string, patterns: string[]): Promise<Result<{ copy: string[]; notIgnored: string[] }>>;
  /** Copies the repo's local files into the feature again, overwriting. */
  copyLocalFilesAgain(featureId: string, repo: string): Promise<Result<string[]>>;
  createSubtask(featureId: string, repo: string): Promise<Result<JiraAlignment>>;

  createFeature(f: NewFeature): Promise<Result<Feature>>;
  addRepoToFeature(featureId: string, repo: string): Promise<Result<void>>;
  archiveFeature(featureId: string): Promise<Result<void>>;
  /** What archiving or deleting the feature would do: PRs to close, branches to delete, work that would be lost. */
  retirePlan(featureId: string): Promise<Result<RetirePlan>>;
  /** Closes its open PRs, deletes its branches (here and on origin), then moves its folder and chat logs to the archive, or deletes them. */
  retireFeature(featureId: string, mode: RetireMode): Promise<Result<RetireOutcome>>;
  restoreFeature(featureId: string): Promise<Result<void>>;
  openPath(path: string): Promise<void>;
  setupLog(featureId: string, repo: string): Promise<string>;

  /** A chat in the feature folder (central), or in one repo's worktree. */
  createChat(featureId: string, agent?: Agent, repo?: string): Promise<Result<Chat>>;
  /** Answers a repo proposal card: the repos to add (empty = none). */
  answerProposal(featureId: string, chatId: string, id: string, repos: string[]): Promise<Result<string[]>>;
  /** Breaks out a chat for a repo with a task (or sends the task to the repo's chat if it has one). */
  startRepoChat(featureId: string, repo: string, message: string, agent?: Agent): Promise<Result<Chat>>;

  docs(featureId: string): Promise<FeatureDocs>;
  writeDoc(featureId: string, doc: "brief" | "plan", text: string): Promise<Result<void>>;
  writeRepoBrief(featureId: string, repo: string, text: string): Promise<Result<void>>;
  tickPlan(featureId: string, line: number, done: boolean): Promise<Result<void>>;
  /** Logs a note from the user and sends it to the chats it is for ("all"/absent: every chat). */
  note(featureId: string, to: string | undefined, text: string): Promise<Result<string[]>>;
  featureStatus(featureId: string): Promise<string>;
  /** Overview of a feature (cached 60 s for GitHub and Jira; fresh bypasses it). */
  overview(featureId: string, fresh?: boolean): Promise<FeatureOverview>;
  models(agent: Agent): Promise<Result<ModelOption[]>>;
  removeChat(chatId: string): Promise<void>;
  chatEvents(chatId: string): Promise<ChatEvent[]>;
  send(chatId: string, text: string): Promise<Result<void>>;
  interrupt(chatId: string): Promise<void>;
  answerPermission(chatId: string, id: string, answer: "allow" | "always" | "deny"): Promise<void>;
  configureChat(chatId: string, patch: { model?: Model; effort?: Effort; mode?: Mode }): Promise<void>;
  answerQuestion(chatId: string, id: string, answers: Record<string, string> | null): Promise<void>;
  onChatEvent(listener: (chatId: string, event: ChatEvent) => void): () => void;

  changes(featureId: string, repo: string): Promise<Result<WorkspaceChanges>>;
  /** Every file git sees in a repo's worktree (tracked + untracked, not ignored). */
  repoFiles(featureId: string, repo: string): Promise<Result<{ files: string[]; truncated: boolean }>>;
  /** One file of a repo's worktree. */
  readRepoFile(featureId: string, repo: string, path: string): Promise<Result<FileContent>>;
  /** A file as it was at the branch's base (what Changes compares with); null when it did not exist there. */
  readBaseFile(featureId: string, repo: string, path: string): Promise<Result<FileContent | null>>;
  /** VS Code on the feature folder, with this file of a repo open at `line`. */
  openInVsCode(featureId: string, repo: string, path: string, line?: number): Promise<Result<void>>;
  filePatch(featureId: string, repo: string, path: string): Promise<Result<string>>;
  addComment(c: {
    featureId: string;
    repo: string;
    file: string;
    line: number;
    side: "new" | "old";
    lineText: string;
    body: string;
  }): Promise<void>;
  removeComment(id: string): Promise<void>;
  resolveComment(id: string, resolved: boolean): Promise<void>;
  /** Sends the unsent user comments to a chat as one message. */
  sendComments(featureId: string, chatId: string): Promise<Result<void>>;

  githubStatus(featureId: string, repo: string): Promise<Result<GitHubStatus>>;
  push(featureId: string, repo: string): Promise<Result<void>>;
  /** Pulls the branch's upstream (fast-forward, else merge); on conflicts it is undone and the files named. */
  pull(featureId: string, repo: string): Promise<Result<MergeOutcome>>;
  /** Merges the base (origin/main) into the branch; on conflicts it is undone and the files named. */
  mergeBase(featureId: string, repo: string): Promise<Result<MergeOutcome>>;
  merge(featureId: string, repo: string, method: MergeMethod): Promise<Result<void>>;
  renameBranch(featureId: string, repo: string, name: string): Promise<Result<void>>;
  openUrl(url: string): Promise<void>;

  doctor(): Promise<DoctorCheck[]>;
  agentLogins(): Promise<AgentLogins>;
  /** Compares the running app with its checkout, and (fetch, the default) the checkout with GitHub. */
  checkForUpdate(fetch?: boolean): Promise<Result<UpdateInfo>>;
  /** Pulls, installs and builds, then restarts the app. Resolves only on failure. */
  update(): Promise<Result<void>>;
  onUpdateLog(listener: (line: string) => void): () => void;
  setTheme(theme: Theme): void;
  focusWindow(): void;
  setBadge(count: number): void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;

  terminalFont(): Promise<string | undefined>;
  terminals(): Promise<Terminal[]>;
  /** A shell in one of the feature's repos, or in the feature folder. */
  openShell(featureId: string, repo?: string): Promise<Result<Terminal>>;
  /** Per feature: how many of its programs run, of how many (for the sidebar). */
  runSummary(): Promise<Record<string, RunSummary>>;
  /** Every repo's run scripts with their state, and programs running outside the Run tab. */
  runOverview(featureId: string): Promise<RunOverview>;
  /** Starts a run script (by id; absent = the repo's first). */
  runStart(featureId: string, repo: string, script?: string): Promise<Result<Terminal>>;
  /** Starts every script that is not running, of one repo or (no repo) of the whole feature. */
  runStartAll(featureId: string, repo?: string): Promise<Result<number>>;
  /** Ctrl-C, then hang up after a grace period, and close its terminal. */
  runStop(terminalId: string): Promise<void>;
  /** Stops every running script of the feature. */
  runStopAll(featureId: string): Promise<void>;
  /** Stops a program holding a port (a stray, or the holder of a port a script needs). */
  runStopHolder(featureId: string, pid: number): Promise<Result<void>>;
  /** Opens a URL a run script declares. */
  runBrowse(featureId: string, repo: string, script: string, url: string): Promise<Result<void>>;
  stopTerminal(id: string): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  termWrite(id: string, data: string): void;
  termResize(id: string, cols: number, rows: number): void;
  termBuffer(id: string): Promise<string>;
  onTermData(listener: (id: string, data: string) => void): () => void;
  onTerminalsChanged(listener: (terminals: Terminal[]) => void): () => void;
};
