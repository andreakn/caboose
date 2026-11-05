// Electron glue: window, IPC and state wiring. The real work is in ./core.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, Effort, Mode, Model } from "../shared/chat.ts";
import type { LocalConfig, State, Theme } from "../shared/types.ts";
import { CopilotClient } from "@github/copilot-sdk";
import { ClaudeProvider, Inbox } from "./core/agents/claude.ts";
import { copilotEnv, CopilotProvider } from "./core/agents/copilot.ts";
import { Chats } from "./core/chats.ts";
import { doctor } from "./core/doctor.ts";
import { checkForUpdate, update } from "./core/updater.ts";
import { installMenu } from "./menu.ts";
import { Comments } from "./core/comments.ts";
import { changes, filePatch } from "./core/diff.ts";
import { cabooseCopilotTools, cabooseInstructions, cabooseMcp } from "./core/mcp.ts";
import { commentsMessage } from "../shared/diff.ts";
import { loadLocalConfig, loadRepoConfig, readLocalConfig, saveLocalConfig } from "./core/config.ts";
import { GitHub } from "./core/github.ts";
import { Terminals } from "./core/terminals.ts";
import type { MergeMethod } from "../shared/github.ts";
import { Store } from "./core/store.ts";
import { Workspaces } from "./core/workspaces.ts";

app.setName("Caboose");
// CABOOSE_DATA points the app at another state folder (screenshots, experiments).
if (process.env.CABOOSE_DATA) app.setPath("userData", process.env.CABOOSE_DATA);

const dataDir = app.getPath("userData");
const store = new Store(join(dataDir, "state.json"));
// The Caboose checkout itself holds this machine's gitignored caboose.local.json.
let localConfig = loadLocalConfig(app.getAppPath());
const workspaces = new Workspaces(store, localConfig, join(dataDir, "logs"));

let win: BrowserWindow | null = null;
const comments = new Comments(store);

// Terminal output is batched per frame: a busy dev server can print thousands of chunks a second.
const pendingOutput = new Map<string, string>();
let flushTimer: NodeJS.Timeout | null = null;
const terminals = new Terminals({
  bashPath: localConfig.bashPath,
  shellPath: localConfig.shellPath,
  onData: (id, data) => {
    pendingOutput.set(id, (pendingOutput.get(id) ?? "") + data);
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      for (const [tid, d] of pendingOutput) win?.webContents.send("term:data", tid, d);
      pendingOutput.clear();
    }, 16);
  },
  onChange: () => win?.webContents.send("term:list", terminals.list()),
});
const workspaceById = (id: string) => store.get().workspaces.find((w) => w.id === id);
const claude = new ClaudeProvider(query, (_chat, ws) => ({
  mcpServers: { caboose: cabooseMcp(() => workspaceById(ws.id) ?? ws, comments, terminals) },
  systemPrompt: { type: "preset", preset: "claude_code", append: cabooseInstructions(ws, "claude") },
}));
const copilot = new CopilotProvider(
  () => new CopilotClient({ logLevel: "error", env: copilotEnv() }),
  (_chat, ws) => ({
    tools: cabooseCopilotTools(() => workspaceById(ws.id) ?? ws, comments, terminals),
    instructions: cabooseInstructions(ws, "copilot"),
  }),
);
const chats = new Chats(store, dataDir, { claude, copilot }, (chatId, e) => win?.webContents.send("chat:event", chatId, e));

// The window opens where it was last closed, if that place is still on a screen.
const boundsFile = join(dataDir, "window.json");
function savedBounds(): Electron.Rectangle | undefined {
  try {
    const b = JSON.parse(readFileSync(boundsFile, "utf8")) as Electron.Rectangle;
    const area = screen.getDisplayMatching(b).workArea;
    const visible = b.x < area.x + area.width - 100 && b.x + b.width > area.x + 100 && b.y >= area.y - 20 && b.y < area.y + area.height - 100;
    return visible ? b : undefined;
  } catch {
    return undefined;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    ...savedBounds(),
    minWidth: 720,
    minHeight: 480,
    title: "Caboose",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1b1a" : "#f7f5f2",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false, // ESM preload needs it off; the renderer only ever loads our own files
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // CABOOSE_VIEW=changes opens on the Changes view (for screenshots).
  const hash = process.env.CABOOSE_VIEW ?? "";
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#${hash}`);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"), { hash });

  win.on("close", () => {
    if (win && !win.isMaximized() && !win.isFullScreen()) writeFileSync(boundsFile, JSON.stringify(win.getBounds()));
  });

  // Never navigate the app window away; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });

  // CABOOSE_SCREENSHOT=file.png: capture the window once it has rendered, then quit.
  const shot = process.env.CABOOSE_SCREENSHOT;
  if (shot) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await win!.webContents.capturePage();
          mkdirSync(dirname(shot), { recursive: true });
          writeFileSync(shot, image.toPNG());
        } catch (e) {
          console.error("screenshot failed:", e);
          process.exitCode = 1;
        }
        app.quit();
      }, 1500);
    });
  }
}

ipcMain.handle("state:get", () => store.get());
ipcMain.handle("repo:pickAndAdd", async () => {
  const r = await dialog.showOpenDialog(win!, { title: "Add repository", properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths[0]) return null;
  return workspaces.addRepo(r.filePaths[0]);
});
ipcMain.handle("repo:remove", (_e, repoId: string) => workspaces.removeRepo(repoId));
ipcMain.handle("workspace:create", (_e, repoId: string) => workspaces.createWorkspace(repoId));
ipcMain.handle("workspace:archive", (_e, id: string) => {
  chats.stopWorkspace(id);
  terminals.closeWorkspace(id);
  return workspaces.archiveWorkspace(id);
});
ipcMain.handle("workspace:restore", (_e, id: string) => workspaces.restoreWorkspace(id));
ipcMain.handle("workspace:setupLog", (_e, id: string) => workspaces.setupLog(id));
ipcMain.handle("shell:openPath", (_e, path: string) => {
  // Only folders Caboose knows about.
  const s = store.get();
  if (s.repos.some((r) => r.path === path) || s.workspaces.some((w) => w.path === path)) return shell.openPath(path);
});

ipcMain.handle("chat:create", (_e, workspaceId: string, agent?: Agent) => chats.create(workspaceId, agent));
ipcMain.handle("chat:models", (_e, agent: Agent) => attempt(() => chats.models(agent)));
ipcMain.handle("chat:remove", (_e, chatId: string) => chats.remove(chatId));
// Synchronous on purpose: chat events sent after this reply are newer than the file it read.
ipcMain.handle("chat:events", (_e, chatId: string) => chats.events(chatId));
ipcMain.handle("chat:send", (_e, chatId: string, text: string) => chats.send(chatId, text));
ipcMain.handle("chat:interrupt", (_e, chatId: string) => chats.interrupt(chatId));
ipcMain.handle("chat:answerPermission", (_e, chatId: string, id: string, answer: "allow" | "always" | "deny") =>
  chats.answerPermission(chatId, id, answer),
);
ipcMain.handle("chat:answerQuestion", (_e, chatId: string, id: string, answers: Record<string, string> | null) =>
  chats.answerQuestion(chatId, id, answers),
);

ipcMain.handle("diff:changes", async (_e, workspaceId: string) => {
  const ws = workspaceById(workspaceId);
  if (!ws || ws.archived) return { ok: false, error: "No such workspace." };
  try {
    return { ok: true, value: await changes(ws.path, ws.baseRef) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
ipcMain.handle("diff:patch", async (_e, workspaceId: string, path: string) => {
  const ws = workspaceById(workspaceId);
  if (!ws || ws.archived) return { ok: false, error: "No such workspace." };
  try {
    const c = await changes(ws.path, ws.baseRef);
    const file = c.files.find((f) => f.path === path);
    return file ? { ok: true, value: await filePatch(ws.path, c.base, file) } : { ok: true, value: "" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
ipcMain.handle(
  "comments:add",
  (_e, c: { workspaceId: string; file: string; line: number; side: "new" | "old"; lineText: string; body: string }) =>
    void comments.add({ ...c, author: "user" }),
);
ipcMain.handle("comments:remove", (_e, id: string) => comments.remove(id));
ipcMain.handle("comments:resolve", (_e, id: string, resolved: boolean) => comments.setResolved(id, resolved));
ipcMain.handle("comments:send", (_e, workspaceId: string, chatId: string) => {
  const unsent = comments.unsent(workspaceId);
  if (!unsent.length) return { ok: false, error: "No unsent comments." };
  const r = chats.send(chatId, commentsMessage(unsent));
  if (r.ok) comments.markSent(unsent.map((c) => c.id));
  return r;
});

const liveWorkspace = (id: string) => {
  const ws = workspaceById(id);
  return ws && !ws.archived ? ws : undefined;
};
ipcMain.handle("repo:config", (_e, workspaceId: string) => {
  const ws = workspaceById(workspaceId);
  const repo = ws && store.get().repos.find((r) => r.id === ws.repoId);
  try {
    return repo ? loadRepoConfig(repo.path) : {};
  } catch {
    return {};
  }
});
const github = new GitHub();
const attempt = async <T>(fn: () => Promise<T>) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};
const archivedError = { ok: false, error: "This workspace is archived." };
ipcMain.handle("github:status", (_e, workspaceId: string) => {
  const ws = liveWorkspace(workspaceId);
  return ws ? attempt(() => github.status(ws.path, ws.branch, ws.baseRef)) : archivedError;
});
ipcMain.handle("github:push", (_e, workspaceId: string) => {
  const ws = liveWorkspace(workspaceId);
  return ws ? attempt(() => github.push(ws.path, ws.branch)) : archivedError;
});
ipcMain.handle("github:merge", async (_e, workspaceId: string, method: MergeMethod) => {
  const ws = liveWorkspace(workspaceId);
  if (!ws) return archivedError;
  return attempt(async () => {
    const pr = await github.pr(ws.path, ws.branch);
    if (!pr || pr.state !== "OPEN") throw new Error("There is no open PR for this branch.");
    await github.merge(ws.path, pr.number, method);
  });
});
ipcMain.handle("github:rename", (_e, workspaceId: string, name: string) => {
  const ws = liveWorkspace(workspaceId);
  if (!ws) return archivedError;
  return attempt(async () => {
    const status = await github.branchStatus(ws.path, ws.baseRef);
    if (status.upstream) throw new Error("The branch is already pushed; renaming it would cut it off from GitHub.");
    await github.renameBranch(ws.path, ws.branch, name.trim());
    workspaces.setBranch(ws.id, name.trim());
  });
});
ipcMain.handle("shell:openUrl", (_e, url: string) => {
  if (/^https:\/\//.test(url)) return shell.openExternal(url);
});
ipcMain.handle("settings:get", () => ({
  local: readLocalConfig(app.getAppPath()),
  resolved: localConfig,
  file: join(app.getAppPath(), "caboose.local.json"),
  dataDir,
  cabooseDir: app.getAppPath(),
}));
ipcMain.handle("settings:save", (_e, local: LocalConfig) =>
  attempt(async () => {
    saveLocalConfig(app.getAppPath(), local);
    localConfig = loadLocalConfig(app.getAppPath());
    workspaces.setConfig(localConfig);
    terminals.setPaths(localConfig.bashPath, localConfig.shellPath);
  }),
);
ipcMain.handle("app:doctor", () =>
  doctor({
    bashPath: localConfig.bashPath,
    claudeAccount,
    copilotAccount: async () => {
      const a = await copilot.auth();
      if (!a.ok) throw new Error(a.detail);
      return a.detail;
    },
  }),
);
ipcMain.handle("app:checkForUpdate", () => attempt(() => checkForUpdate(app.getAppPath())));
ipcMain.handle("app:update", (e) =>
  attempt(async () => {
    await update(app.getAppPath(), (line) => e.sender.send("app:updateLog", line));
    app.relaunch();
    app.quit();
  }),
);
ipcMain.on("app:theme", (_e, theme: Theme) => {
  nativeTheme.themeSource = theme;
});
ipcMain.on("window:focus", () => {
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
});
ipcMain.on("app:badge", (_e, count: number) => app.setBadgeCount(count));

/** Who Claude Code is logged in as: starts a session, asks, and ends it without sending anything. */
async function claudeAccount(): Promise<string> {
  const inbox = new Inbox<SDKUserMessage>();
  const q = query({ prompt: inbox, options: { cwd: app.getPath("home") } });
  try {
    const a = await Promise.race([
      q.accountInfo(),
      new Promise<never>((_r, reject) => setTimeout(() => reject(new Error("Claude Code did not answer in 30 s")), 30_000)),
    ]);
    if (a.subscriptionType) return `logged in, ${a.subscriptionType}`;
    if (a.apiKeySource && a.apiKeySource !== "none") return `using an API key (${a.apiKeySource})`;
    if (a.apiProvider && a.apiProvider !== "firstParty") return `using ${a.apiProvider}`;
    if (a.email) return "logged in";
    throw new Error("Not logged in");
  } finally {
    inbox.end();
    q.close();
  }
}

ipcMain.handle("config:terminalFont", () => localConfig.terminalFont);
ipcMain.handle("term:list", (_e, workspaceId: string) => terminals.list(workspaceId));
ipcMain.handle("term:openShell", (_e, workspaceId: string) => {
  const ws = liveWorkspace(workspaceId);
  if (!ws) return { ok: false, error: "This workspace is archived." };
  try {
    return { ok: true, value: terminals.openShell(ws.id, { cwd: ws.path, env: workspaces.scriptEnv(ws.id) }) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
ipcMain.handle("term:run", async (_e, workspaceId: string) => {
  const ws = liveWorkspace(workspaceId);
  const repo = ws && store.get().repos.find((r) => r.id === ws.repoId);
  if (!ws || !repo) return { ok: false, error: "This workspace is archived." };
  try {
    const run = loadRepoConfig(repo.path).run;
    if (!run) return { ok: false, error: `No run script. Add "run" to caboose.json in ${repo.name}.` };
    return { ok: true, value: await terminals.run(ws.id, run, { cwd: ws.path, env: workspaces.scriptEnv(ws.id) }) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
});
ipcMain.handle("term:stop", (_e, id: string) => terminals.stop(id));
ipcMain.handle("term:close", (_e, id: string) => terminals.close(id));
ipcMain.handle("term:buffer", (_e, id: string) => terminals.buffer(id));
ipcMain.on("term:write", (_e, id: string, data: string) => terminals.write(id, data));
ipcMain.on("term:resize", (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));

ipcMain.handle("chat:configure", (_e, chatId: string, patch: { model?: Model; effort?: Effort; mode?: Mode }) =>
  chats.configure(chatId, patch),
);

store.subscribe((s: State) => win?.webContents.send("state:changed", s));

app.whenReady().then(() => {
  installMenu(() => win);
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  void copilot.stop();
  chats.stopAll();
  terminals.closeAll();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
