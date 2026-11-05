import { contextBridge, ipcRenderer } from "electron";
import type { ChatEvent } from "../shared/chat.ts";
import type { CabooseApi, State } from "../shared/types.ts";

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
  onChatEvent: (listener) => {
    const handler = (_e: unknown, chatId: string, event: ChatEvent) => listener(chatId, event);
    ipcRenderer.on("chat:event", handler);
    return () => ipcRenderer.removeListener("chat:event", handler);
  },
};

contextBridge.exposeInMainWorld("caboose", api);
