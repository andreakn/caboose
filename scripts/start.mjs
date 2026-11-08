// Starts the built app (npm start). On macOS, Cmd-Tab, the Dock and the menu
// bar name an app after the bundle that was launched, and run from a clone
// that is node_modules/electron/dist/Electron.app: "Electron". So Caboose
// launches its own copy, .caboose-app/Caboose.app, named and iconed Caboose.
// The copy is an APFS clone (no extra disk space), signed ad hoc like the
// original, and made again whenever Electron or the icon changes. Other OSes
// start Electron as it is (their windows already say Caboose).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = createRequire(import.meta.url)("electron"); // the path of Electron's executable

/** .caboose-app/Caboose.app, made (again) when it is missing or out of date; null when that fails. */
function macApp() {
  const source = join(root, "node_modules", "electron", "dist", "Electron.app");
  const dir = join(root, ".caboose-app");
  const app = join(dir, "Caboose.app");
  const icon = join(root, "assets", "icon.png");
  const version = readFileSync(join(root, "node_modules", "electron", "package.json"), "utf8").match(/"version":\s*"([^"]+)"/)?.[1];
  const stamp = `${version} ${existsSync(icon) ? createHash("sha1").update(readFileSync(icon)).digest("hex") : "no-icon"}`;
  const stampFile = join(dir, "stamp");
  if (existsSync(join(app, "Contents", "MacOS", "Electron")) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return app;

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // -c: an APFS clone, instant and free; a plain copy elsewhere.
  try {
    execFileSync("cp", ["-cR", source, app]);
  } catch {
    execFileSync("cp", ["-R", source, app]);
  }
  const plist = join(app, "Contents", "Info.plist");
  const set = (key, value) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
  const add = (key, value) => {
    try {
      set(key, value);
    } catch {
      execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} string ${value}`, plist]);
    }
  };
  add("CFBundleName", "Caboose");
  add("CFBundleDisplayName", "Caboose");
  // Its own id, so macOS does not mix it up with other Electron apps.
  set("CFBundleIdentifier", "com.caboose.app");
  if (existsSync(icon)) {
    const iconset = join(tmpdir(), `caboose-${process.pid}.iconset`);
    mkdirSync(iconset, { recursive: true });
    for (const size of [16, 32, 128, 256, 512]) {
      execFileSync("sips", ["-z", String(size), String(size), icon, "--out", join(iconset, `icon_${size}x${size}.png`)], { stdio: "ignore" });
      execFileSync("sips", ["-z", String(size * 2), String(size * 2), icon, "--out", join(iconset, `icon_${size}x${size}@2x.png`)], { stdio: "ignore" });
    }
    execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(app, "Contents", "Resources", "caboose.icns")]);
    rmSync(iconset, { recursive: true, force: true });
    set("CFBundleIconFile", "caboose.icns");
  }
  // The original is signed ad hoc; so is the copy, now that its Info.plist changed.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "ignore" });
  writeFileSync(stampFile, stamp);
  return app;
}

let executable = electron;
if (process.platform === "darwin") {
  try {
    const app = macApp();
    if (app) executable = join(app, "Contents", "MacOS", "Electron");
  } catch (e) {
    console.error(`Could not make Caboose.app (starting as Electron): ${e.message}`);
  }
}
const child = spawn(executable, [root, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
