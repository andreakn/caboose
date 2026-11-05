import { contextBridge, ipcRenderer } from "electron";
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
};

contextBridge.exposeInMainWorld("caboose", api);
