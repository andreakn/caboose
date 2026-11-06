// Shapes shared by the main process, the preload bridge and the renderer.
import type { Agent, Chat, ChatEvent, Effort, Mode, Model, ModelOption } from "./chat.ts";
import type { DiffComment, WorkspaceChanges } from "./diff.ts";
import type { GitHubStatus, MergeMethod, PrDetails } from "./github.ts";

export type SetupState = "none" | "running" | "ok" | "failed";

/** A repo's scripts: setup when a worktree is made, named run scripts, archive before it is removed. */
export type RepoScripts = {
  setup?: string;
  archive?: string;
  run?: { name: string; command: string }[];
};

/** A repo the user works in, from the config: its name is also its folder name inside a feature. */
export type RepoEntry = {
  name: string;
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
};

export type Terminal = {
  id: string;
  featureId: string;
  /** The repo it was opened in; none = the feature folder. */
  repo?: string;
  kind: "shell" | "run";
  title: string;
  startedAt: string;
  /** Set once the process has exited. */
  exitCode?: number;
};

export type State = {
  features: Feature[];
  chats: Chat[];
  comments: DiffComment[];
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
  /** Project key for new tasks, e.g. NWP. */
  project?: string;
};

/** This machine's settings, in `caboose.local.json` in the Caboose checkout (gitignored). */
export type LocalConfig = {
  /** Where feature folders go. Default: ~/caboose/features */
  featuresRoot?: string;
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
  /** How PRs should be written (title, description style); added to Create PR requests to the agent. */
  prInstructions?: string;
  /** Commands to open a folder in an app, overriding detection; "{path}" is replaced. */
  openWith?: Partial<Record<AppId, string>>;
};

/** Apps a folder can be opened in. */
export type AppId = "vscode" | "rider" | "visualStudio" | "terminal" | "files";
export type AppInfo = { id: AppId; label: string };

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
  defaults: { featuresRoot: string; branchPrefix: string; localFiles: string[] };
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

export type NewFeature = {
  /** Repos to add right away (none = an empty feature, built out later). */
  repos?: string[];
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
  setFeatureDetails(featureId: string, details: { title?: string; status?: FeatureStatus }): Promise<Result<void>>;
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
  merge(featureId: string, repo: string, method: MergeMethod): Promise<Result<void>>;
  renameBranch(featureId: string, repo: string, name: string): Promise<Result<void>>;
  openUrl(url: string): Promise<void>;

  doctor(): Promise<DoctorCheck[]>;
  agentLogins(): Promise<AgentLogins>;
  checkForUpdate(): Promise<Result<UpdateInfo>>;
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
  /** Runs one of the repo's run scripts (by name; absent = the first). */
  runScript(featureId: string, repo: string, script?: string): Promise<Result<Terminal>>;
  stopTerminal(id: string): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  termWrite(id: string, data: string): void;
  termResize(id: string, cols: number, rows: number): void;
  termBuffer(id: string): Promise<string>;
  onTermData(listener: (id: string, data: string) => void): () => void;
  onTerminalsChanged(listener: (terminals: Terminal[]) => void): () => void;
};
