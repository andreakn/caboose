// Electron glue: window, IPC and state wiring. The real work is in ./core.
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, safeStorage, screen, shell } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Agent, Chat, Effort, Mode, Model } from "../shared/chat.ts";
import { checksSummary } from "../shared/github.ts";
import { commentsMessage } from "../shared/diff.ts";
import type { MergeMethod } from "../shared/github.ts";
import type { AppId, ConfigInput, Feature, FeatureStatus, NewFeature, RetireMode, State, Theme } from "../shared/types.ts";
import { CopilotClient } from "@github/copilot-sdk";
import { ClaudeProvider, Inbox } from "./core/agents/claude.ts";
import { copilotEnv, CopilotProvider } from "./core/agents/copilot.ts";
import { Chats } from "./core/chats.ts";
import { Coordinator } from "./core/coordination.ts";
import { readDocs, setTask, writeDoc, writeRepoBrief } from "./core/docs.ts";
import { Comments } from "./core/comments.ts";
import {
  applyConfigInput,
  configExists,
  configFile,
  configView,
  defaultArchiveRoot,
  defaultFeaturesRoot,
  jiraToken,
  loadLocalConfig,
  loadRepoConfig,
  readLocalConfig,
  saveLocalConfig,
  type SecretCodec,
} from "./core/config.ts";
import { availableApps, openIn, realMachine } from "./core/apps.ts";
import { conductorImport, conductorRules } from "./core/conductor.ts";
import { changes, filePatch } from "./core/diff.ts";
import { listFiles, readRepoFile } from "./core/files.ts";
import { doctor } from "./core/doctor.ts";
import { checkRepo, Features, scanRepos } from "./core/features.ts";
import { GitHub } from "./core/github.ts";
import { Jira } from "./core/jira.ts";
import { DEFAULT_LOCAL_FILES, scanLocalFiles } from "./core/localfiles.ts";
import { cabooseCopilotTools, cabooseInstructions, cabooseMcp } from "./core/mcp.ts";
import { featureOverview } from "./core/overview.ts";
import { PrDetailsCache } from "./core/prdetails.ts";
import { Store } from "./core/store.ts";
import { retire, retirePlan } from "./core/retire.ts";
import { git } from "./core/run.ts";
import { Runner } from "./core/runner.ts";
import { Terminals } from "./core/terminals.ts";
import { checkForUpdate, update } from "./core/updater.ts";
import { installMenu } from "./menu.ts";

app.setName("Caboose");
// CABOOSE_DATA points the app at another state folder (screenshots, experiments).
if (process.env.CABOOSE_DATA) app.setPath("userData", process.env.CABOOSE_DATA);
// One Caboose per state folder: a second start (e.g. typing `caboose` again) shows the open window instead.
if (!app.requestSingleInstanceLock()) process.exit(0);
app.on("second-instance", () => {
  if (win?.isMinimized()) win.restore();
  win?.show();
  win?.focus();
});

const dataDir = app.getPath("userData");
/** The commit this copy of Caboose was started from (the checkout may move on while it runs). */
const runningCommit = git(app.getAppPath(), "rev-parse", "HEAD").catch(() => undefined);
const store = new Store(join(dataDir, "state.json"));
// The Caboose checkout itself holds this machine's gitignored caboose.local.json.
// CABOOSE_CONFIG_DIR points elsewhere (tests, screenshots).
const configDir = process.env.CABOOSE_CONFIG_DIR ?? app.getAppPath();
let localConfig = loadLocalConfig(configDir);

/** Secrets in the config are encrypted with the OS keychain (safeStorage); ready after app start. */
const codec: SecretCodec = {
  get canEncrypt() {
    return app.isReady() && safeStorage.isEncryptionAvailable();
  },
  encrypt: (s) => safeStorage.encryptString(s).toString("base64"),
  decrypt: (s) => safeStorage.decryptString(Buffer.from(s, "base64")),
};
/** A Jira client when Jira is on and has site, email and token. */
function jira(): Jira | null {
  const j = localConfig.jira;
  if (j.level === "off" || !j.site || !j.email) return null;
  const token = jiraToken(j, codec);
  return token ? new Jira({ site: j.site, email: j.email, token }) : null;
}
const needJira = () => {
  const j = jira();
  if (!j) throw new Error("Jira is not set up: add the site, email and API token in Configure.");
  return j;
};

const features = new Features(store, localConfig, join(dataDir, "logs"), jira);
const featureById = (id: string) => store.get().features.find((f) => f.id === id);

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
const runner = new Runner({
  terminals,
  features: () => store.get().features,
  repos: () => localConfig.repos,
  scriptsFor: (repo, source) => features.scriptsFor(repo, source),
  scriptEnv: (featureId, repo) => features.scriptEnv(featureId, repo),
  monikersFile: () => localConfig.monikersFile,
});
const current = (f: Feature) => () => featureById(f.id) ?? f;
/** What Caboose's tools work with, for one chat. `coordinator` is set below (the tools only run later). */
const toolContext = (chat: Chat, f: Feature) => ({
  feature: current(f),
  chat: () => store.get().chats.find((c) => c.id === chat.id) ?? chat,
  comments,
  terminals,
  coord: coordinator,
});
const claude = new ClaudeProvider(query, (chat, f) => ({
  mcpServers: { caboose: cabooseMcp(toolContext(chat, f)) },
  systemPrompt: { type: "preset", preset: "claude_code", append: cabooseInstructions(f, "claude", chat, localConfig.repos) },
}));
const copilot = new CopilotProvider(
  () => new CopilotClient({ logLevel: "error", env: copilotEnv() }),
  (chat, f) => ({ tools: cabooseCopilotTools(toolContext(chat, f)), instructions: cabooseInstructions(f, "copilot", chat, localConfig.repos) }),
);
const chats = new Chats(
  store,
  dataDir,
  { claude, copilot },
  (chatId, e) => win?.webContents.send("chat:event", chatId, e),
  () => ({ agent: localConfig.defaultAgent, mode: localConfig.defaultMode }),
);
const github = new GitHub();
const coordinator = new Coordinator({
  store,
  chats,
  jiraOf: (id) => features.jiraOf(id),
  repos: () => localConfig.repos,
  addRepo: (featureId, repo) => features.addRepo(featureId, repo),
  setTitle: (featureId, title) => features.setDetails(featureId, { title }),
  facts: async (r) => {
    const b = await github.branchStatus(r.path, r.baseRef);
    const pr = await github.pr(r.path, r.branch).catch(() => null);
    const c = pr && checksSummary(pr.checks);
    return {
      uncommitted: b.uncommitted,
      ahead: b.ahead,
      pushed: Boolean(b.upstream),
      pr: pr && {
        number: pr.number,
        state: pr.isDraft ? "DRAFT" : pr.state,
        checks: !pr.checks.length ? "none" : c!.failed ? "failing" : c!.pending ? "running" : "passing",
        url: pr.url,
      },
    };
  },
});

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

const attempt = async <T>(fn: () => T | Promise<T>) => {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};
/** A live (not archived) feature and one of its repos, or an error. */
function liveRepo(featureId: string, repo: string) {
  const f = featureById(featureId);
  if (!f || f.archived) throw new Error("This feature is archived.");
  const r = f.repos.find((x) => x.name === repo);
  if (!r) throw new Error(`No repo "${repo}" in this feature.`);
  return { f, r };
}

ipcMain.handle("state:get", () => store.get());

// --- config
ipcMain.handle("config:get", () => ({
  config: configView(readLocalConfig(configDir)),
  defaults: { featuresRoot: defaultFeaturesRoot(), archiveRoot: defaultArchiveRoot(), branchPrefix: "caboose", localFiles: DEFAULT_LOCAL_FILES },
  firstRun: !configExists(configDir),
  file: configFile(configDir),
  dataDir,
  canEncrypt: codec.canEncrypt,
}));
ipcMain.handle("config:save", (_e, input: ConfigInput) =>
  attempt(() => {
    saveLocalConfig(configDir, applyConfigInput(readLocalConfig(configDir), input, codec));
    localConfig = loadLocalConfig(configDir);
    features.setConfig(localConfig);
    terminals.setPaths(localConfig.bashPath, localConfig.shellPath);
  }),
);
ipcMain.handle("config:pickFolder", async (_e, title: string) => {
  const r = await dialog.showOpenDialog(win!, { title, properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle("config:checkRepo", (_e, path: string) => checkRepo(path));
ipcMain.handle("config:scanRepos", (_e, folder: string) => scanRepos(folder));
ipcMain.handle("config:previewLocalFiles", (_e, repoPath: string, patterns: string[]) =>
  attempt(() => scanLocalFiles(repoPath, patterns)),
);
ipcMain.handle("config:terminalFont", () => localConfig.terminalFont);

// --- jira
ipcMain.handle("jira:test", () => attempt(() => needJira().myself()));
ipcMain.handle("jira:issue", (_e, key: string) => attempt(() => needJira().issue(key)));
ipcMain.handle("jira:mine", () => attempt(() => needJira().myIssues()));
ipcMain.handle("jira:feature", (_e, featureId: string) => features.jiraOf(featureId));
ipcMain.handle("jira:setTask", (_e, featureId: string, key: string | null) => features.setTask(featureId, key));
ipcMain.handle("feature:details", (_e, featureId: string, details: { title?: string; status?: FeatureStatus }) =>
  features.setDetails(featureId, details),
);
ipcMain.handle("feature:scripts", (_e, featureId: string, repo: string) => {
  const r = featureById(featureId)?.repos.find((x) => x.name === repo);
  return r ? features.scriptsFor(r.name, r.source) : {};
});
ipcMain.handle("conductor:import", () => attempt(() => conductorImport(new Set(localConfig.repos.map((r) => r.path)))));
ipcMain.handle("config:repoRules", (_e, path: string) => conductorRules(path));
ipcMain.handle("apps:list", () => availableApps(realMachine(), localConfig.openWith));
ipcMain.handle("apps:open", (_e, app: AppId, path: string) =>
  attempt(() => {
    // Only folders Caboose knows: features, their worktrees, configured repos.
    const known =
      store.get().features.some((f) => f.folder === path || f.repos.some((r) => r.path === path)) ||
      localConfig.repos.some((r) => r.path === path);
    if (!known) throw new Error(`Not a folder Caboose knows: ${path}`);
    openIn(app, path, realMachine(), localConfig.openWith?.[app]);
  }),
);
ipcMain.handle("jira:setSubtask", (_e, featureId: string, repo: string, key: string | null) =>
  features.setSubtask(featureId, repo, key),
);
ipcMain.handle("jira:createSubtask", (_e, featureId: string, repo: string) => features.createSubtask(featureId, repo));

// --- features
ipcMain.handle("feature:create", async (_e, input: NewFeature) => {
  const text = input.text?.trim();
  const firstLine = text?.split("\n")[0] ?? "";
  const r = await features.create({ ...input, title: input.title ?? (firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine || undefined) });
  // The central chat, with the chosen agent; with a description it starts on it right away (and proposes the repos).
  if (r.ok) {
    const chat = chats.create(r.value.id, input.agent);
    if (chat.ok && text) chats.send(chat.value.id, text);
  }
  return r;
});
ipcMain.handle("feature:addRepo", (_e, featureId: string, repo: string) => features.addRepo(featureId, repo));
ipcMain.handle("feature:archive", async (_e, id: string) => {
  chats.stopFeature(id);
  await runner.stopAll(id); // Ctrl-C first, so programs shut down cleanly
  terminals.closeFeature(id);
  return features.archive(id);
});
ipcMain.handle("feature:retirePlan", (_e, id: string) =>
  attempt(() => retirePlan(featureOrThrow(id), { github, archiveRoot: localConfig.archiveRoot })),
);
ipcMain.handle("feature:retire", (_e, id: string, mode: RetireMode) =>
  attempt(async () => {
    const f = featureOrThrow(id);
    const out = await retire(f, mode, {
      github,
      archiveRoot: localConfig.archiveRoot,
      chats: store.get().chats,
      transcript: (chatId) => chats.events(chatId).filter((e) => e.t !== "status"),
      logs: features.logs(f.id),
      archiveScript: (r) => features.runArchiveScript(f.id, r),
      stop: async () => {
        chats.stopFeature(f.id);
        await runner.stopAll(f.id); // Ctrl-C first, so programs shut down cleanly
        terminals.closeFeature(f.id);
      },
    });
    chats.forgetFeature(f.id);
    features.forget(f.id);
    return out;
  }),
);
ipcMain.handle("feature:copyLocalFiles", (_e, featureId: string, repo: string) => features.copyLocalFilesAgain(featureId, repo));
ipcMain.handle("feature:restore", (_e, id: string) => features.restore(id));
ipcMain.handle("feature:setupLog", (_e, id: string, repo: string) => features.setupLog(id, repo));
ipcMain.handle("shell:openPath", (_e, path: string) => {
  // Only folders Caboose knows about.
  const known = store.get().features.some((f) => f.folder === path || f.repos.some((r) => r.path === path));
  if (known) return shell.openPath(path);
});
ipcMain.handle("shell:openUrl", (_e, url: string) => {
  if (/^https:\/\//.test(url)) return shell.openExternal(url);
});

// --- chats
ipcMain.handle("chat:create", (_e, featureId: string, agent?: Agent, repo?: string) => chats.create(featureId, agent, repo));
ipcMain.handle("chat:answerProposal", (_e, featureId: string, chatId: string, id: string, repos: string[]) =>
  coordinator.answerProposal(featureId, chatId, id, repos),
);
ipcMain.handle("chat:startRepo", (_e, featureId: string, repo: string, message: string, agent?: Agent) =>
  coordinator.startRepoChat(featureId, repo, message, { agent, from: "you" }),
);

// --- feature documents (plain files in the feature folder)
const featureOrThrow = (id: string) => {
  const f = featureById(id);
  if (!f) throw new Error("Unknown feature.");
  return f;
};
ipcMain.handle("docs:get", (_e, featureId: string) => {
  const f = featureOrThrow(featureId);
  return readDocs(f.folder, f.repos.map((r) => r.name));
});
ipcMain.handle("docs:write", (_e, featureId: string, doc: "brief" | "plan", text: string) =>
  attempt(() => writeDoc(featureOrThrow(featureId).folder, doc, text)),
);
ipcMain.handle("docs:writeRepoBrief", (_e, featureId: string, repo: string, text: string) =>
  attempt(() => writeRepoBrief(featureOrThrow(featureId).folder, repo, text)),
);
ipcMain.handle("docs:tick", (_e, featureId: string, line: number, done: boolean) =>
  attempt(() => setTask(featureOrThrow(featureId).folder, line, done)),
);
ipcMain.handle("docs:note", (_e, featureId: string, to: string | undefined, text: string) =>
  coordinator.noteFromUser(featureId, to, text),
);
ipcMain.handle("docs:status", (_e, featureId: string) => coordinator.status(featureId));
const prDetails = new PrDetailsCache();
ipcMain.handle("feature:overview", (_e, featureId: string, fresh?: boolean) =>
  featureOverview(featureOrThrow(featureId), { github, prs: prDetails, jira, jiraOf: (id) => features.jiraOf(id), onBranch: (id, repo, branch) => features.setBranch(id, repo, branch) }, Boolean(fresh)),
);
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
ipcMain.handle("chat:configure", (_e, chatId: string, patch: { model?: Model; effort?: Effort; mode?: Mode }) =>
  chats.configure(chatId, patch),
);

// --- changes and comments
ipcMain.handle("files:list", (_e, featureId: string, repo: string) => attempt(() => listFiles(liveRepo(featureId, repo).r.path)));
ipcMain.handle("files:read", (_e, featureId: string, repo: string, path: string) =>
  attempt(() => readRepoFile(liveRepo(featureId, repo).r.path, path)),
);
ipcMain.handle("diff:changes", (_e, featureId: string, repo: string) =>
  attempt(() => {
    const { r } = liveRepo(featureId, repo);
    return changes(r.path, r.baseRef);
  }),
);
ipcMain.handle("diff:patch", (_e, featureId: string, repo: string, path: string) =>
  attempt(async () => {
    const { r } = liveRepo(featureId, repo);
    const c = await changes(r.path, r.baseRef);
    const file = c.files.find((f) => f.path === path);
    return file ? filePatch(r.path, c.base, file) : "";
  }),
);
ipcMain.handle(
  "comments:add",
  (_e, c: { featureId: string; repo: string; file: string; line: number; side: "new" | "old"; lineText: string; body: string }) =>
    void comments.add({ ...c, author: "user" }),
);
ipcMain.handle("comments:remove", (_e, id: string) => comments.remove(id));
ipcMain.handle("comments:resolve", (_e, id: string, resolved: boolean) => comments.setResolved(id, resolved));
ipcMain.handle("comments:send", (_e, featureId: string, chatId: string) => {
  const unsent = comments.unsent(featureId);
  if (!unsent.length) return { ok: false, error: "No unsent comments." };
  const r = chats.send(chatId, commentsMessage(unsent));
  if (r.ok) comments.markSent(unsent.map((c) => c.id));
  return r;
});

// --- github
ipcMain.handle("github:status", (_e, featureId: string, repo: string) =>
  attempt(async () => {
    const { f, r } = liveRepo(featureId, repo);
    const s = await github.status(r.path, r.branch, r.baseRef);
    // Follow the branch the worktree is on now (an agent may have made one with the Jira key in it).
    if (s.branch.head && s.branch.head !== r.branch) features.setBranch(f.id, r.name, s.branch.head);
    return s;
  }),
);
ipcMain.handle("github:push", (_e, featureId: string, repo: string) =>
  attempt(() => {
    const { r } = liveRepo(featureId, repo);
    return github.push(r.path, r.branch);
  }),
);
ipcMain.handle("github:pull", (_e, featureId: string, repo: string) => attempt(() => github.pull(liveRepo(featureId, repo).r.path)));
ipcMain.handle("github:mergeBase", (_e, featureId: string, repo: string) =>
  attempt(() => {
    const { r } = liveRepo(featureId, repo);
    return github.mergeBase(r.path, r.baseRef);
  }),
);
ipcMain.handle("github:merge", (_e, featureId: string, repo: string, method: MergeMethod) =>
  attempt(async () => {
    const { r } = liveRepo(featureId, repo);
    const pr = await github.pr(r.path, r.branch);
    if (!pr || pr.state !== "OPEN") throw new Error("There is no open PR for this branch.");
    await github.merge(r.path, pr.number, method);
  }),
);
ipcMain.handle("github:rename", (_e, featureId: string, repo: string, name: string) =>
  attempt(async () => {
    const { f, r } = liveRepo(featureId, repo);
    const status = await github.branchStatus(r.path, r.baseRef);
    if (status.upstream) throw new Error("The branch is already pushed; renaming it would cut it off from GitHub.");
    await github.renameBranch(r.path, r.branch, name.trim());
    features.setBranch(f.id, r.name, name.trim());
  }),
);

// --- app
ipcMain.handle("app:doctor", () =>
  doctor({
    bashPath: localConfig.bashPath,
    mainAgent: localConfig.defaultAgent,
    claudeAccount,
    copilotAccount: async () => {
      const a = await copilot.auth();
      if (!a.ok) throw new Error(a.detail);
      return a.detail;
    },
  }),
);
/** Whether each agent is logged in here (for picking the main agent). */
ipcMain.handle("agents:logins", async () => {
  const settle = async (fn: () => Promise<string>) => {
    try {
      return { ok: true, detail: await fn() };
    } catch (e) {
      return { ok: false, detail: (e as Error).message.split("\n")[0] };
    }
  };
  const [c, p] = await Promise.all([
    settle(claudeAccount),
    settle(async () => {
      const a = await copilot.auth();
      if (!a.ok) throw new Error(a.detail);
      return a.detail;
    }),
  ]);
  return { claude: c, copilot: p };
});
ipcMain.handle("app:checkForUpdate", (_e, fetch = true) =>
  attempt(async () => checkForUpdate(app.getAppPath(), fetch, await runningCommit)),
);
ipcMain.handle("app:update", (e) =>
  attempt(async () => {
    await update(app.getAppPath(), (line) => e.sender.send("app:updateLog", line), await runningCommit);
    // Let the new copy take the single-instance lock while this one shuts down.
    app.releaseSingleInstanceLock();
    app.relaunch();
    app.quit();
    // Something holding the quit up must not leave the old version running.
    setTimeout(() => app.exit(0), 8000).unref();
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

// --- terminals
ipcMain.handle("term:list", () => terminals.list());
ipcMain.handle("term:openShell", (_e, featureId: string, repo?: string) =>
  attempt(() => {
    const f = featureById(featureId);
    if (!f || f.archived) throw new Error("This feature is archived.");
    const cwd = repo ? liveRepo(featureId, repo).r.path : f.folder;
    return terminals.openShell(f.id, { cwd, env: features.scriptEnv(f.id, repo) }, repo);
  }),
);
ipcMain.handle("term:stop", (_e, id: string) => terminals.stop(id));
ipcMain.handle("term:close", (_e, id: string) => terminals.close(id));
ipcMain.handle("term:buffer", (_e, id: string) => terminals.buffer(id));
ipcMain.on("term:write", (_e, id: string, data: string) => terminals.write(id, data));
ipcMain.on("term:resize", (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows));

// --- the Run tab
ipcMain.handle("run:overview", (_e, featureId: string) => runner.overview(featureId));
ipcMain.handle("run:start", (_e, featureId: string, repo: string, script?: string) => attempt(() => runner.start(featureId, repo, script)));
ipcMain.handle("run:startAll", (_e, featureId: string, repo?: string) => attempt(() => runner.startAll(featureId, repo)));
ipcMain.handle("run:stop", (_e, terminalId: string) => runner.stop(terminalId));
ipcMain.handle("run:stopAll", (_e, featureId: string) => runner.stopAll(featureId));
ipcMain.handle("run:stopHolder", (_e, featureId: string, pid: number) => attempt(() => runner.stopHolder(featureId, pid)));
ipcMain.handle("run:browse", (_e, featureId: string, repo: string, script: string, url: string) =>
  attempt(() => shell.openExternal(runner.browseUrl(featureId, repo, script, url))),
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
