// Opening a folder in another app: VS Code (everywhere), Rider (macOS and
// Windows), Visual Studio (Windows), the OS's terminal and file manager.
// Detection is per OS; `openWith` in the config overrides any of them with a
// command where "{path}" is the folder (or solution) to open.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import type { AppId, AppInfo } from "../../shared/types.ts";

export type Launch = { file: string; args: string[]; cwd?: string; shell?: boolean };

/** What detection needs from the machine; injectable for tests. */
export type Machine = {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists: (p: string) => boolean;
  list: (dir: string) => string[];
};

export const realMachine = (): Machine => ({
  platform: process.platform,
  env: process.env,
  home: homedir(),
  exists: existsSync,
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
});

/** Paths joined the way the target OS writes them (tests run Windows cases on any OS). */
const joinFor = (m: Machine) => (m.platform === "win32" ? win32.join : posix.join);

/** An executable on PATH (with PATHEXT on Windows), or null. */
export function which(name: string, m: Machine): string | null {
  const exts = m.platform === "win32" ? (m.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase()) : [""];
  const join = joinFor(m);
  for (const dir of (m.env.PATH ?? m.env.Path ?? "").split(m.platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (m.exists(p)) return p;
    }
  }
  return null;
}

/** The single .sln/.slnx at the top of a folder, which Rider and Visual Studio open much faster than the folder. */
export function solutionIn(path: string, m: Machine): string | null {
  const slns = m.list(path).filter((f) => /\.slnx?$/i.test(f));
  return slns.length === 1 ? joinFor(m)(path, slns[0]) : null;
}

const macApp = (m: Machine, ...names: string[]) =>
  names.find((n) => m.exists(`/Applications/${n}.app`) || m.exists(posix.join(m.home, "Applications", `${n}.app`))) ?? null;

/** How to open `path` in `app` on this machine, or null when the app is not there. */
export function launchFor(app: AppId, path: string, m: Machine, override?: string): Launch | null {
  if (override?.trim()) {
    const [file, ...args] = splitCommand(override.replace(/\{path\}/g, path));
    return { file, args, cwd: path };
  }
  const target = (app === "rider" || app === "visualStudio") && solutionIn(path, m) ? solutionIn(path, m)! : path;
  if (m.platform === "darwin") {
    const a = {
      vscode: macApp(m, "Visual Studio Code"),
      rider: macApp(m, "Rider", "JetBrains Rider"),
      visualStudio: null,
      terminal: macApp(m, "iTerm", "Ghostty", "Warp") ?? "Terminal",
      files: "Finder",
    }[app];
    if (!a) return null;
    return app === "files" ? { file: "open", args: [path] } : { file: "open", args: ["-a", a, target] };
  }
  if (m.platform === "win32") {
    const join = win32.join;
    const local = m.env.LOCALAPPDATA ?? join(m.home, "AppData", "Local");
    const pf = m.env.ProgramFiles ?? "C:\\Program Files";
    const pf86 = m.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    switch (app) {
      case "vscode": {
        const exe = [join(local, "Programs", "Microsoft VS Code", "Code.exe"), join(pf, "Microsoft VS Code", "Code.exe")].find(m.exists);
        if (exe) return { file: exe, args: [path] };
        const cli = which("code", m);
        return cli ? { file: cli, args: [path], shell: true } : null;
      }
      case "rider": {
        const toolbox = join(local, "JetBrains", "Toolbox", "scripts", "rider.cmd");
        if (m.exists(toolbox)) return { file: toolbox, args: [target], shell: true };
        const dir = m.list(join(pf, "JetBrains")).filter((d) => /rider/i.test(d)).sort().at(-1);
        const exe = dir && join(pf, "JetBrains", dir, "bin", "rider64.exe");
        return exe && m.exists(exe) ? { file: exe, args: [target] } : null;
      }
      case "visualStudio": {
        for (const root of [join(pf, "Microsoft Visual Studio"), join(pf86, "Microsoft Visual Studio")]) {
          for (const year of m.list(root).filter((d) => /^\d{4}$/.test(d)).sort().reverse()) {
            for (const edition of ["Enterprise", "Professional", "Community", "Preview"]) {
              const exe = join(root, year, edition, "Common7", "IDE", "devenv.exe");
              if (m.exists(exe)) return { file: exe, args: [target] };
            }
          }
        }
        return null;
      }
      case "terminal": {
        const wt = which("wt", m) ?? [join(local, "Microsoft", "WindowsApps", "wt.exe")].find(m.exists);
        if (wt) return { file: wt, args: ["-d", path] };
        return { file: "cmd.exe", args: ["/c", "start", "", "/D", path, "powershell.exe", "-NoExit"] };
      }
      case "files":
        return { file: "explorer.exe", args: [path] };
    }
  }
  // Linux and the other Unixes
  switch (app) {
    case "vscode": {
      const code = which("code", m) ?? which("codium", m);
      return code ? { file: code, args: [path] } : null;
    }
    case "terminal": {
      const terms: [string, (p: string) => string[]][] = [
        ["gnome-terminal", (p) => [`--working-directory=${p}`]],
        ["konsole", (p) => ["--workdir", p]],
        ["xfce4-terminal", (p) => [`--working-directory=${p}`]],
        ["kitty", (p) => ["--directory", p]],
        ["alacritty", (p) => ["--working-directory", p]],
        ["wezterm", (p) => ["start", "--cwd", p]],
        ["x-terminal-emulator", () => []],
        ["xterm", () => []],
      ];
      for (const [name, args] of terms) {
        const exe = which(name, m);
        if (exe) return { file: exe, args: args(path), cwd: path };
      }
      return null;
    }
    case "files": {
      const open = which("xdg-open", m);
      return open ? { file: open, args: [path] } : null;
    }
    default:
      return null;
  }
}

/**
 * VS Code on `folder` with `file` open at `line`: its command-line tool with
 * `-g file:line`, so a window already showing the folder is reused. On macOS
 * the tool inside the app bundle works even if "code" was never put on PATH.
 */
export function launchVsCodeAt(folder: string, file: string, line: number, m: Machine, override?: string): Launch | null {
  const goto = ["-g", `${file}:${Math.max(1, line)}`];
  if (override?.trim()) {
    const [exe, ...args] = splitCommand(override.replace(/\{path\}/g, folder));
    return { file: exe, args: override.includes("{path}") ? [...args, ...goto] : [...args, folder, ...goto] };
  }
  if (m.platform === "darwin") {
    const app = macApp(m, "Visual Studio Code");
    const bundled = app && [`/Applications/${app}.app`, posix.join(m.home, "Applications", `${app}.app`)].map((a) => `${a}/Contents/Resources/app/bin/code`).find(m.exists);
    const cli = bundled ?? which("code", m);
    return cli ? { file: cli, args: [folder, ...goto] } : null;
  }
  if (m.platform === "win32") {
    const local = m.env.LOCALAPPDATA ?? win32.join(m.home, "AppData", "Local");
    const pf = m.env.ProgramFiles ?? "C:\\Program Files";
    const cmd = [win32.join(local, "Programs", "Microsoft VS Code", "bin", "code.cmd"), win32.join(pf, "Microsoft VS Code", "bin", "code.cmd")].find(m.exists) ?? which("code", m);
    return cmd ? { file: cmd, args: [folder, ...goto], shell: true } : null;
  }
  const cli = which("code", m) ?? which("codium", m);
  return cli ? { file: cli, args: [folder, ...goto] } : null;
}

export function openVsCodeAt(folder: string, file: string, line: number, m: Machine, override?: string): void {
  const l = launchVsCodeAt(folder, file, line, m, override);
  if (!l) throw new Error("VS Code was not found on this machine.");
  const child = spawn(l.file, l.args, { cwd: folder, shell: l.shell, detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

const LABELS: Record<AppId, (p: NodeJS.Platform) => string> = {
  vscode: () => "VS Code",
  rider: () => "Rider",
  visualStudio: () => "Visual Studio",
  terminal: () => "Terminal",
  files: (p) => (p === "darwin" ? "Finder" : p === "win32" ? "Explorer" : "Files"),
};

/** The apps this machine can open folders in. */
export function availableApps(m: Machine, overrides: Partial<Record<AppId, string>> = {}): AppInfo[] {
  const probe = m.platform === "win32" ? "C:\\" : "/";
  return (Object.keys(LABELS) as AppId[])
    .filter((id) => launchFor(id, probe, m, overrides[id]))
    .map((id) => ({ id, label: LABELS[id](m.platform) }));
}

export function openIn(app: AppId, path: string, m: Machine, override?: string): void {
  const l = launchFor(app, path, m, override);
  if (!l) throw new Error(`${LABELS[app](m.platform)} was not found on this machine.`);
  const child = spawn(l.file, l.args, { cwd: l.cwd, shell: l.shell, detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
}

/** Splits a command line on spaces, keeping "quoted parts" together. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(cmd); m; m = re.exec(cmd)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
