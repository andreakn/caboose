import assert from "node:assert/strict";
import { test } from "node:test";
import { availableApps, launchFor, launchVsCodeAt, type Machine, splitCommand } from "../src/main/core/apps.ts";

function machine(platform: NodeJS.Platform, files: string[], env: Record<string, string> = {}, dirs: Record<string, string[]> = {}): Machine {
  const set = new Set(files);
  return { platform, env, home: platform === "win32" ? "C:\\Users\\me" : "/home/me", exists: (p) => set.has(p), list: (d) => dirs[d] ?? [] };
}

test("macOS: open -a, the solution for Rider, iTerm before Terminal", () => {
  const m = machine("darwin", ["/Applications/Visual Studio Code.app", "/Applications/iTerm.app", "/home/me/Applications/Rider.app"], {}, {
    "/w/api": ["Api.sln", "src"],
  });
  assert.deepEqual(launchFor("vscode", "/w/api", m), { file: "open", args: ["-a", "Visual Studio Code", "/w/api"] });
  assert.deepEqual(launchFor("rider", "/w/api", m), { file: "open", args: ["-a", "Rider", "/w/api/Api.sln"] });
  assert.deepEqual(launchFor("terminal", "/w/api", m), { file: "open", args: ["-a", "iTerm", "/w/api"] });
  assert.equal(launchFor("visualStudio", "/w/api", m), null);
  assert.deepEqual(availableApps(m).map((a) => a.label), ["VS Code", "Rider", "Terminal", "Finder"]);
});

test("Windows: VS Code, Rider via Toolbox, Visual Studio's devenv, Windows Terminal", () => {
  const local = "C:\\Users\\me\\AppData\\Local";
  const m = machine(
    "win32",
    [
      `${local}\\Programs\\Microsoft VS Code\\Code.exe`,
      `${local}\\JetBrains\\Toolbox\\scripts\\rider.cmd`,
      "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\Common7\\IDE\\devenv.exe",
      `${local}\\Microsoft\\WindowsApps\\wt.exe`,
    ],
    { LOCALAPPDATA: local, ProgramFiles: "C:\\Program Files", PATH: "" },
    { "C:\\Program Files\\Microsoft Visual Studio": ["2019", "2022", "Installer"], "D:\\w\\api": ["Api.slnx"] },
  );
  assert.equal(launchFor("vscode", "D:\\w\\api", m)?.file, `${local}\\Programs\\Microsoft VS Code\\Code.exe`);
  assert.deepEqual(launchFor("rider", "D:\\w\\api", m), { file: `${local}\\JetBrains\\Toolbox\\scripts\\rider.cmd`, args: ["D:\\w\\api\\Api.slnx"], shell: true });
  assert.deepEqual(launchFor("visualStudio", "D:\\w\\api", m)?.args, ["D:\\w\\api\\Api.slnx"]);
  assert.deepEqual(launchFor("terminal", "D:\\w\\api", m), { file: `${local}\\Microsoft\\WindowsApps\\wt.exe`, args: ["-d", "D:\\w\\api"] });
  assert.deepEqual(launchFor("files", "D:\\w\\api", m), { file: "explorer.exe", args: ["D:\\w\\api"] });
});

test("Linux: code and the first terminal found on PATH; no Rider or Visual Studio", () => {
  const m = machine("linux", ["/usr/bin/code", "/usr/bin/konsole", "/usr/bin/xdg-open"], { PATH: "/usr/local/bin:/usr/bin" });
  assert.deepEqual(launchFor("vscode", "/w", m), { file: "/usr/bin/code", args: ["/w"] });
  assert.deepEqual(launchFor("terminal", "/w", m), { file: "/usr/bin/konsole", args: ["--workdir", "/w"], cwd: "/w" });
  assert.deepEqual(availableApps(m).map((a) => a.id), ["vscode", "terminal", "files"]);
});

test("overrides from the config win", () => {
  const m = machine("linux", [], { PATH: "" });
  assert.deepEqual(launchFor("rider", "/w/x", m, '"/opt/rider/bin/rider.sh" {path}'), { file: "/opt/rider/bin/rider.sh", args: ["/w/x"], cwd: "/w/x" });
  assert.deepEqual(splitCommand(`a "b c" 'd' e`), ["a", "b c", "d", "e"]);
});

test("VS Code at a file: the feature folder with -g file:line, through its command-line tool", () => {
  const bundled = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
  const mac = machine("darwin", ["/Applications/Visual Studio Code.app", bundled], { PATH: "" });
  assert.deepEqual(launchVsCodeAt("/f/oslo", "/f/oslo/web/src/a.ts", 12, mac), { file: bundled, args: ["/f/oslo", "-g", "/f/oslo/web/src/a.ts:12"] });
  assert.equal(launchVsCodeAt("/f", "/f/a", 1, machine("darwin", [], { PATH: "" })), null);

  const local = "C:\\Users\\me\\AppData\\Local";
  const win = machine("win32", [`${local}\\Programs\\Microsoft VS Code\\bin\\code.cmd`], { LOCALAPPDATA: local, PATH: "" });
  assert.deepEqual(launchVsCodeAt("D:\\f\\oslo", "D:\\f\\oslo\\web\\a.ts", 0, win), {
    file: `${local}\\Programs\\Microsoft VS Code\\bin\\code.cmd`,
    args: ["D:\\f\\oslo", "-g", "D:\\f\\oslo\\web\\a.ts:1"],
    shell: true,
  });

  const linux = machine("linux", ["/usr/bin/codium"], { PATH: "/usr/bin" });
  assert.deepEqual(launchVsCodeAt("/f", "/f/a.ts", 3, linux), { file: "/usr/bin/codium", args: ["/f", "-g", "/f/a.ts:3"] });
  assert.deepEqual(launchVsCodeAt("/f", "/f/a.ts", 3, linux, "/opt/code/code {path}"), { file: "/opt/code/code", args: ["/f", "-g", "/f/a.ts:3"] });
});
