// Shapes shared by the main process, the preload bridge and the renderer.
import type { Agent, Chat, ChatEvent, Effort, Mode, Model, ModelOption } from "./chat.ts";
import type { DiffComment, WorkspaceChanges } from "./diff.ts";
import type { GitHubStatus, MergeMethod } from "./github.ts";

export type SetupState = "none" | "running" | "ok" | "failed";

/** A repo the user works in, from the config: its name is also its folder name inside a feature. */
export type RepoEntry = { name: string; path: string };

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
};

/** A piece of work: a station name, a folder, and one worktree per repo. */
export type Feature = {
  id: string;
  /** The station name, also the folder name. */
  name: string;
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
  /** Gitignored files copied from the main checkout into new worktrees (e.g. ".env"). */
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
};

/** The config as the window sees it: the token is never sent, only whether there is one. */
export type ConfigView = Omit<LocalConfig, "jira"> & { jira?: Omit<JiraConfig, "token"> & { hasToken: boolean } };
/** What the window saves: `token` is a new token to store, null to remove it, absent to keep it. */
export type ConfigInput = Omit<LocalConfig, "jira"> & { jira?: Omit<JiraConfig, "token"> & { token?: string | null } };

export type ConfigInfo = {
  config: ConfigView;
  /** With defaults filled in. */
  defaults: { featuresRoot: string; branchPrefix: string };
  /** No config file yet: show the setup screen. */
  firstRun: boolean;
  file: string;
  dataDir: string;
  /** Whether secrets can be encrypted on this machine (false on Linux without a keyring). */
  canEncrypt: boolean;
};

export type JiraIssue = { key: string; summary: string; status: string; type: string; url: string; subtasks?: { key: string; summary: string }[] };

/** The Jira links of a feature, as written in its jira.txt. */
export type FeatureJira = { task?: string; subtasks: Record<string, string> };

export type NewFeature = {
  repos: string[];
  /** An existing task key, or the summary of a task to create in the configured project. */
  jira?: { key: string } | { create: string };
};

export type DoctorCheck = { name: string; ok: boolean; detail: string; hint?: string };

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
  setFeatureTask(featureId: string, key: string | null): Promise<Result<void>>;
  setRepoSubtask(featureId: string, repo: string, key: string | null): Promise<Result<void>>;
  createSubtask(featureId: string, repo: string): Promise<Result<string>>;

  createFeature(f: NewFeature): Promise<Result<Feature>>;
  addRepoToFeature(featureId: string, repo: string): Promise<Result<void>>;
  archiveFeature(featureId: string): Promise<Result<void>>;
  restoreFeature(featureId: string): Promise<Result<void>>;
  openPath(path: string): Promise<void>;
  setupLog(featureId: string, repo: string): Promise<string>;
  repoConfig(featureId: string, repo: string): Promise<RepoConfig>;

  createChat(featureId: string, agent?: Agent): Promise<Result<Chat>>;
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
  runScript(featureId: string, repo: string): Promise<Result<Terminal>>;
  stopTerminal(id: string): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  termWrite(id: string, data: string): void;
  termResize(id: string, cols: number, rows: number): void;
  termBuffer(id: string): Promise<string>;
  onTermData(listener: (id: string, data: string) => void): () => void;
  onTerminalsChanged(listener: (terminals: Terminal[]) => void): () => void;
};
