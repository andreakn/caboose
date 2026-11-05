// Shapes shared by the main process, the preload bridge and the renderer.
import type { Chat, ChatEvent, Effort, Mode, Model } from "./chat.ts";
import type { DiffComment, WorkspaceChanges } from "./diff.ts";
import type { GitHubStatus, MergeMethod } from "./github.ts";

export type Repo = {
  id: string;
  name: string;
  /** Absolute path to the main checkout. */
  path: string;
  /** What new workspaces branch from, e.g. "origin/main" or "main". */
  baseRef: string;
  addedAt: string;
};

export type SetupState = "none" | "running" | "ok" | "failed";

export type Workspace = {
  id: string;
  repoId: string;
  /** The station name, also the folder name. */
  name: string;
  branch: string;
  /** Absolute path to the worktree. */
  path: string;
  baseRef: string;
  createdAt: string;
  archived: boolean;
  setup: SetupState;
  /** First of 10 ports reserved for this workspace (CABOOSE_PORT). */
  port?: number;
};

export type Terminal = {
  id: string;
  workspaceId: string;
  kind: "shell" | "run";
  title: string;
  startedAt: string;
  /** Set once the process has exited. */
  exitCode?: number;
};

export type State = {
  repos: Repo[];
  workspaces: Workspace[];
  chats: Chat[];
  comments: DiffComment[];
};

/** Per-repo settings, read from `caboose.json` in the repo's main checkout. */
export type RepoConfig = {
  /** Shell command run in a new workspace (e.g. "npm install"). */
  setup?: string;
  /** Shell command for the run button (later phase). */
  run?: string;
  /** Shell command run before a workspace is archived. */
  archive?: string;
  /** Gitignored files copied from the main checkout into new workspaces (e.g. ".env"). */
  copy?: string[];
};

/** This machine's settings, read from `caboose.local.json` in the Caboose checkout (gitignored). */
export type LocalConfig = {
  /** Where worktrees go. Default: ~/caboose/workspaces */
  workspacesRoot?: string;
  /** Branch prefix for new workspaces. Default: "caboose". */
  branchPrefix?: string;
  /** Path to bash for repo scripts. Default: bash on PATH, or Git for Windows' bash. */
  bashPath?: string;
  /** Shell for terminals. Default: $SHELL on macOS/Linux, PowerShell on Windows. */
  shellPath?: string;
  /** Font for terminals, e.g. a Nerd Font your prompt needs. Default: common Nerd/Powerline fonts, then monospace. */
  terminalFont?: string;
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
  | "newWorkspace"
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
  | "nextWorkspace"
  | "prevWorkspace";

export type SettingsInfo = {
  /** What caboose.local.json says, without defaults. */
  local: LocalConfig;
  /** With defaults filled in, as used. */
  resolved: LocalConfig;
  file: string;
  dataDir: string;
  cabooseDir: string;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** What the preload script exposes as `window.caboose`. */
export type CabooseApi = {
  getState(): Promise<State>;
  pickAndAddRepo(): Promise<Result<Repo> | null>;
  removeRepo(repoId: string): Promise<Result<void>>;
  createWorkspace(repoId: string): Promise<Result<Workspace>>;
  archiveWorkspace(workspaceId: string): Promise<Result<void>>;
  restoreWorkspace(workspaceId: string): Promise<Result<void>>;
  openPath(path: string): Promise<void>;
  setupLog(workspaceId: string): Promise<string>;
  onStateChanged(listener: (state: State) => void): () => void;

  createChat(workspaceId: string): Promise<Result<Chat>>;
  removeChat(chatId: string): Promise<void>;
  chatEvents(chatId: string): Promise<ChatEvent[]>;
  send(chatId: string, text: string): Promise<Result<void>>;
  interrupt(chatId: string): Promise<void>;
  answerPermission(chatId: string, id: string, answer: "allow" | "always" | "deny"): Promise<void>;
  configureChat(chatId: string, patch: { model?: Model; effort?: Effort; mode?: Mode }): Promise<void>;
  answerQuestion(chatId: string, id: string, answers: Record<string, string> | null): Promise<void>;
  onChatEvent(listener: (chatId: string, event: ChatEvent) => void): () => void;

  changes(workspaceId: string): Promise<Result<WorkspaceChanges>>;
  filePatch(workspaceId: string, path: string): Promise<Result<string>>;
  addComment(c: { workspaceId: string; file: string; line: number; side: "new" | "old"; lineText: string; body: string }): Promise<void>;
  removeComment(id: string): Promise<void>;
  resolveComment(id: string, resolved: boolean): Promise<void>;
  /** Sends the unsent user comments to a chat as one message. */
  sendComments(workspaceId: string, chatId: string): Promise<Result<void>>;

  githubStatus(workspaceId: string): Promise<Result<GitHubStatus>>;
  push(workspaceId: string): Promise<Result<void>>;
  merge(workspaceId: string, method: MergeMethod): Promise<Result<void>>;
  renameBranch(workspaceId: string, name: string): Promise<Result<void>>;
  openUrl(url: string): Promise<void>;

  settings(): Promise<SettingsInfo>;
  saveSettings(local: LocalConfig): Promise<Result<void>>;
  doctor(): Promise<DoctorCheck[]>;
  checkForUpdate(): Promise<Result<UpdateInfo>>;
  /** Pulls, installs and builds, then restarts the app. Resolves only on failure. */
  update(): Promise<Result<void>>;
  onUpdateLog(listener: (line: string) => void): () => void;
  setTheme(theme: Theme): void;
  focusWindow(): void;
  setBadge(count: number): void;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;

  repoConfig(workspaceId: string): Promise<RepoConfig>;
  terminalFont(): Promise<string | undefined>;
  terminals(workspaceId: string): Promise<Terminal[]>;
  openShell(workspaceId: string): Promise<Result<Terminal>>;
  runScript(workspaceId: string): Promise<Result<Terminal>>;
  stopTerminal(id: string): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  termWrite(id: string, data: string): void;
  termResize(id: string, cols: number, rows: number): void;
  termBuffer(id: string): Promise<string>;
  onTermData(listener: (id: string, data: string) => void): () => void;
  onTerminalsChanged(listener: (terminals: Terminal[]) => void): () => void;
};
