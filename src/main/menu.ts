// The app menu: standard Edit/Window roles (copy/paste need them on macOS)
// plus Caboose's commands, which the window carries out.
import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import type { MenuCommand } from "../shared/types.ts";

export function installMenu(win: () => BrowserWindow | null): void {
  const send = (command: MenuCommand) => () => win()?.webContents.send("menu:command", command);
  const item = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: send(command),
  });
  const mac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              item("Settings…", "Cmd+,", "settings"),
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        item("New Workspace", "CmdOrCtrl+N", "newWorkspace"),
        item("New Chat Tab", "CmdOrCtrl+T", "newChat"),
        item("New Terminal", "CmdOrCtrl+Shift+T", "newTerminal"),
        { type: "separator" },
        item("Add Repository…", "CmdOrCtrl+Shift+O", "addRepo"),
        ...(mac ? [] : ([{ type: "separator" }, item("Settings…", "Ctrl+,", "settings"), { role: "quit" }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        item("Chat", "CmdOrCtrl+1", "showChat"),
        item("Changes", "CmdOrCtrl+2", "showChanges"),
        item("Toggle Terminal", "CmdOrCtrl+J", "toggleTerminal"),
        item("Focus Message Box", "CmdOrCtrl+L", "focusComposer"),
        { type: "separator" },
        item("Next Chat Tab", "CmdOrCtrl+Shift+]", "nextChat"),
        item("Previous Chat Tab", "CmdOrCtrl+Shift+[", "prevChat"),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "reload", accelerator: "CmdOrCtrl+Shift+R" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "Workspace",
      submenu: [
        item("Run / Restart", "CmdOrCtrl+R", "run"),
        item("Stop Claude", "CmdOrCtrl+.", "stopClaude"),
        { type: "separator" },
        item("Next Workspace", "CmdOrCtrl+Alt+Down", "nextWorkspace"),
        item("Previous Workspace", "CmdOrCtrl+Alt+Up", "prevWorkspace"),
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
