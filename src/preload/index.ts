import { contextBridge, ipcRenderer } from "electron";
import type { ChatEvent } from "../shared/chat.ts";
import type { CabooseApi, MenuCommand, State, Terminal } from "../shared/types.ts";

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api: CabooseApi = {
  getState: invoke("state:get"),
  saveSidebar: invoke("sidebar:save"),
  onReleaseNews: (listener) => {
    const handler = (_e: unknown, news: Parameters<typeof listener>[0]) => listener(news);
    ipcRenderer.on("release:news", handler);
    return () => ipcRenderer.removeListener("release:news", handler);
  },
  onStateChanged: (listener) => {
    const handler = (_e: unknown, s: State) => listener(s);
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.removeListener("state:changed", handler);
  },

  config: invoke("config:get"),
  saveConfig: invoke("config:save"),
  setHome: invoke("config:setHome"),
  pickFolder: invoke("config:pickFolder"),
  checkRepo: invoke("config:checkRepo"),
  scanRepos: invoke("config:scanRepos"),

  jiraTest: invoke("jira:test"),
  jiraIssue: invoke("jira:issue"),
  jiraMyIssues: invoke("jira:mine"),
  featureJira: invoke("jira:feature"),
  setFeatureTask: invoke("jira:setTask"),
  setRepoSubtask: invoke("jira:setSubtask"),
  previewLocalFiles: invoke("config:previewLocalFiles"),
  setFeatureDetails: invoke("feature:details"),
  addableRepos: invoke("feature:addable"),
  releasePlan: invoke("release:plan"),
  tagRelease: invoke("release:tag"),
  requestCopilotReview: invoke("github:copilotReview"),
  archivedFeatures: invoke("archived:list"),
  archivedChat: invoke("archived:chat"),
  archivedDocs: invoke("archived:docs"),
  continueFeature: invoke("archived:continue"),
  setComponents: invoke("feature:components"),
  repoScripts: invoke("feature:scripts"),
  conductorImport: invoke("conductor:import"),
  repoRules: invoke("config:repoRules"),
  apps: invoke("apps:list"),
  openIn: invoke("apps:open"),
  copyLocalFilesAgain: invoke("feature:copyLocalFiles"),
  createSubtask: invoke("jira:createSubtask"),
  createFeatureTask: invoke("jira:createTask"),
  alignJira: invoke("jira:align"),

  createFeature: invoke("feature:create"),
  addRepoToFeature: invoke("feature:addRepo"),
  archiveFeature: invoke("feature:archive"),
  repoFiles: invoke("files:list"),
  repoDir: invoke("files:dir"),
  readRepoFile: invoke("files:read"),
  readBaseFile: invoke("files:readBase"),
  openInVsCode: invoke("apps:vscodeAt"),
  retirePlan: invoke("feature:retirePlan"),
  retireFeature: invoke("feature:retire"),
  restoreFeature: invoke("feature:restore"),
  openPath: invoke("shell:openPath"),
  setupLog: invoke("feature:setupLog"),

  createChat: invoke("chat:create"),
  startRepoChat: invoke("chat:startRepo"),
  answerProposal: invoke("chat:answerProposal"),
  docs: invoke("docs:get"),
  writeDoc: invoke("docs:write"),
  writeRepoBrief: invoke("docs:writeRepoBrief"),
  tickPlan: invoke("docs:tick"),
  tickTodo: invoke("docs:todo"),
  addTodo: invoke("docs:addTodo"),
  note: invoke("docs:note"),
  featureStatus: invoke("docs:status"),
  overview: invoke("feature:overview"),
  models: invoke("chat:models"),
  commands: invoke("chat:commands"),
  removeChat: invoke("chat:remove"),
  chatEvents: invoke("chat:events"),
  send: invoke("chat:send"),
  interrupt: invoke("chat:interrupt"),
  answerPermission: invoke("chat:answerPermission"),
  configureChat: invoke("chat:configure"),
  answerQuestion: invoke("chat:answerQuestion"),
  onChatEvent: (listener) => {
    const handler = (_e: unknown, chatId: string, event: ChatEvent) => listener(chatId, event);
    ipcRenderer.on("chat:event", handler);
    return () => ipcRenderer.removeListener("chat:event", handler);
  },

  changes: invoke("diff:changes"),
  filePatch: invoke("diff:patch"),
  addComment: invoke("comments:add"),
  removeComment: invoke("comments:remove"),
  resolveComment: invoke("comments:resolve"),
  sendComments: invoke("comments:send"),

  githubStatus: invoke("github:status"),
  push: invoke("github:push"),
  pull: invoke("github:pull"),
  mergeBase: invoke("github:mergeBase"),
  merge: invoke("github:merge"),
  renameBranch: invoke("github:rename"),
  openUrl: invoke("shell:openUrl"),

  doctor: invoke("app:doctor"),
  agentLogins: invoke("agents:logins"),
  checkForUpdate: invoke("app:checkForUpdate"),
  update: invoke("app:update"),
  onUpdateLog: (listener) => {
    const handler = (_e: unknown, line: string) => listener(line);
    ipcRenderer.on("app:updateLog", handler);
    return () => ipcRenderer.removeListener("app:updateLog", handler);
  },
  setTheme: (theme) => ipcRenderer.send("app:theme", theme),
  focusWindow: () => ipcRenderer.send("window:focus"),
  setBadge: (count) => ipcRenderer.send("app:badge", count),
  onMenuCommand: (listener) => {
    const handler = (_e: unknown, command: MenuCommand) => listener(command);
    ipcRenderer.on("menu:command", handler);
    return () => ipcRenderer.removeListener("menu:command", handler);
  },

  terminalFont: invoke("config:terminalFont"),
  terminals: invoke("term:list"),
  openShell: invoke("term:openShell"),
  runOverview: invoke("run:overview"),
  runSummary: invoke("run:summary"),
  runStart: invoke("run:start"),
  runStartAll: invoke("run:startAll"),
  runStop: invoke("run:stop"),
  runStopAll: invoke("run:stopAll"),
  runStopHolder: invoke("run:stopHolder"),
  runBrowse: invoke("run:browse"),
  stopTerminal: invoke("term:stop"),
  closeTerminal: invoke("term:close"),
  termWrite: (id, data) => ipcRenderer.send("term:write", id, data),
  termResize: (id, cols, rows) => ipcRenderer.send("term:resize", id, cols, rows),
  termBuffer: invoke("term:buffer"),
  onTermData: (listener) => {
    const handler = (_e: unknown, id: string, data: string) => listener(id, data);
    ipcRenderer.on("term:data", handler);
    return () => ipcRenderer.removeListener("term:data", handler);
  },
  onTerminalsChanged: (listener) => {
    const handler = (_e: unknown, list: Terminal[]) => listener(list);
    ipcRenderer.on("term:list", handler);
    return () => ipcRenderer.removeListener("term:list", handler);
  },
} as CabooseApi;

contextBridge.exposeInMainWorld("caboose", api);
