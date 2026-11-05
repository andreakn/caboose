// Shapes shared by the main process, the preload bridge and the renderer.
import type { Chat, ChatEvent, Effort, Mode, Model } from "./chat.ts";
import type { DiffComment, WorkspaceChanges } from "./diff.ts";

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
};
