// Renders assets/icon.svg to assets/icon.png (1024 px, transparent corners),
// with Electron so it works the same on every OS:
//   npx electron scripts/make-icon.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = readFileSync(join(root, "assets", "icon.svg"), "utf8");
const SIZE = 1024;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 300));
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: "best" });
  writeFileSync(join(root, "assets", "icon.png"), image.toPNG());
  console.log(`assets/icon.png: ${image.getSize().width}×${image.getSize().height}`);
  app.quit();
});
