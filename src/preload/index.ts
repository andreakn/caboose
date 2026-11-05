import { contextBridge, ipcRenderer } from "electron";
import type { ChatEvent } from "../shared/chat.ts";
import type { CabooseApi, State, Terminal } from "../shared/types.ts";

const api: CabooseApi = {
  getState: () => ipcRenderer.invoke("state:get"),
  pickAndAddRepo: () => ipcRenderer.invoke("repo:pickAndAdd"),
  removeRepo: (repoId) => ipcRenderer.invoke("repo:remove", repoId),
  createWorkspace: (repoId) => ipcRenderer.invoke("workspace:create", repoId),
  archiveWorkspace: (id) => ipcRenderer.invoke("workspace:archive", id),
  restoreWorkspace: (id) => ipcRenderer.invoke("workspace:restore", id),
  openPath: (path) => ipcRenderer.invoke("shell:openPath", path),
  setupLog: (id) => ipcRenderer.invoke("workspace:setupLog", id),
  onStateChanged: (listener) => {
    const handler = (_e: unknown, s: State) => listener(s);
    ipcRenderer.on("state:changed", handler);
    return () => ipcRenderer.removeListener("state:changed", handler);
  },

  createChat: (workspaceId) => ipcRenderer.invoke("chat:create", workspaceId),
  removeChat: (chatId) => ipcRenderer.invoke("chat:remove", chatId),
  chatEvents: (chatId) => ipcRenderer.invoke("chat:events", chatId),
  send: (chatId, text) => ipcRenderer.invoke("chat:send", chatId, text),
  interrupt: (chatId) => ipcRenderer.invoke("chat:interrupt", chatId),
  answerPermission: (chatId, id, answer) => ipcRenderer.invoke("chat:answerPermission", chatId, id, answer),
  configureChat: (chatId, patch) => ipcRenderer.invoke("chat:configure", chatId, patch),
  answerQuestion: (chatId, id, answers) => ipcRenderer.invoke("chat:answerQuestion", chatId, id, answers),
  changes: (workspaceId) => ipcRenderer.invoke("diff:changes", workspaceId),
  filePatch: (workspaceId, path) => ipcRenderer.invoke("diff:patch", workspaceId, path),
  addComment: (c) => ipcRenderer.invoke("comments:add", c),
  removeComment: (id) => ipcRenderer.invoke("comments:remove", id),
  resolveComment: (id, resolved) => ipcRenderer.invoke("comments:resolve", id, resolved),
  sendComments: (workspaceId, chatId) => ipcRenderer.invoke("comments:send", workspaceId, chatId),
  repoConfig: (workspaceId) => ipcRenderer.invoke("repo:config", workspaceId),
  terminalFont: () => ipcRenderer.invoke("config:terminalFont"),
  terminals: (workspaceId) => ipcRenderer.invoke("term:list", workspaceId),
  openShell: (workspaceId) => ipcRenderer.invoke("term:openShell", workspaceId),
  runScript: (workspaceId) => ipcRenderer.invoke("term:run", workspaceId),
  stopTerminal: (id) => ipcRenderer.invoke("term:stop", id),
  closeTerminal: (id) => ipcRenderer.invoke("term:close", id),
  termWrite: (id, data) => ipcRenderer.send("term:write", id, data),
  termResize: (id, cols, rows) => ipcRenderer.send("term:resize", id, cols, rows),
  termBuffer: (id) => ipcRenderer.invoke("term:buffer", id),
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
  onChatEvent: (listener) => {
    const handler = (_e: unknown, chatId: string, event: ChatEvent) => listener(chatId, event);
    ipcRenderer.on("chat:event", handler);
    return () => ipcRenderer.removeListener("chat:event", handler);
  },
};

contextBridge.exposeInMainWorld("caboose", api);
