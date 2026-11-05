// Electron glue: window, IPC and state wiring. The real work is in ./core.
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { State } from "../shared/types.ts";
import { loadLocalConfig } from "./core/config.ts";
import { Store } from "./core/store.ts";
import { Workspaces } from "./core/workspaces.ts";

app.setName("Caboose");
// CABOOSE_DATA points the app at another state folder (screenshots, experiments).
if (process.env.CABOOSE_DATA) app.setPath("userData", process.env.CABOOSE_DATA);

const dataDir = app.getPath("userData");
const store = new Store(join(dataDir, "state.json"));
// The Caboose checkout itself holds this machine's gitignored caboose.local.json.
const workspaces = new Workspaces(store, loadLocalConfig(app.getAppPath()), join(dataDir, "logs"));

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "Caboose",
    backgroundColor: "#1c1b1a",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      sandbox: false, // ESM preload needs it off; the renderer only ever loads our own files
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(import.meta.dirname, "../renderer/index.html"));

  // Never navigate the app window away; links open in the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

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
ipcMain.handle("workspace:archive", (_e, id: string) => workspaces.archiveWorkspace(id));
ipcMain.handle("workspace:restore", (_e, id: string) => workspaces.restoreWorkspace(id));
ipcMain.handle("workspace:setupLog", (_e, id: string) => workspaces.setupLog(id));
ipcMain.handle("shell:openPath", (_e, path: string) => {
  // Only folders Caboose knows about.
  const s = store.get();
  if (s.repos.some((r) => r.path === path) || s.workspaces.some((w) => w.path === path)) return shell.openPath(path);
});

store.subscribe((s: State) => win?.webContents.send("state:changed", s));

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
