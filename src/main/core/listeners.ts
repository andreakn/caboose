// Programs listening on TCP ports, and where they run from. Something started
// from a worktree by hand, by an agent (`nohup … &`) or from an IDE holds its
// port, so starting it from the Run tab fails; cross_conductor showed those
// with a stop button, and so does Caboose.
//   macOS: lsof + ps.  Linux: lsof, else ss; + ps.  Windows: PowerShell
//   (Get-NetTCPConnection, Win32_Process).
// Without any of them the Run tab still works, it just cannot see strays.
import { basename } from "node:path";
import { run } from "./run.ts";

export type Proc = { pid: number; ppid: number; command: string };

/** A listening program: its ports and, if it is one of Caboose's terminals' processes, that terminal. */
export type Listener = { pid: number; name: string; command: string; ports: number[]; terminalId?: string; wrappers: number[] };

// Launchers like `dotnet run` / `npm run dev` sit above the listener and are stopped with it; never a shell.
const SHELLS = /^-?(zsh|bash|sh|fish|dash|login|tmux|screen|cmd|powershell|pwsh|conhost|wsl|explorer)$/i;

const programName = (command: string) => basename(command.trim().split(/\s+/)[0] ?? "").replace(/\.exe$/i, "").replace(/^"|"$/g, "");

/**
 * Joins the process table with the listening ports. `ptys` are Caboose's
 * terminals (pid → terminal id): their descendants are "ours". `self` is
 * Caboose's own pid: neither it nor its direct children (the agents) are ever
 * a launcher to stop.
 */
export function listeners(procs: Map<number, Proc>, ports: Map<number, Set<number>>, ptys: Map<number, string>, self: number): Listener[] {
  const terminalOf = (pid: number): string | undefined => {
    for (let p = procs.get(pid), n = 0; p && n < 64; p = procs.get(p.ppid), n++) {
      const t = ptys.get(p.pid);
      if (t) return t;
    }
    return undefined;
  };
  const out: Listener[] = [];
  for (const [pid, set] of ports) {
    const proc = procs.get(pid);
    if (!proc || pid === self) continue;
    const terminalId = terminalOf(pid);
    const wrappers: number[] = [];
    if (!terminalId) {
      for (let up = procs.get(proc.ppid); up && up.pid > 1 && wrappers.length < 3; up = procs.get(up.ppid)) {
        if (up.pid === self || up.ppid === self || SHELLS.test(programName(up.command))) break;
        wrappers.push(up.pid);
      }
    }
    out.push({
      pid,
      name: programName(proc.command),
      command: proc.command,
      ports: [...set].sort((a, b) => a - b),
      ...(terminalId ? { terminalId } : {}),
      wrappers,
    });
  }
  return out.sort((a, b) => a.ports[0] - b.ports[0]);
}

/** Which of these folders a program runs from (its command line mentions a file inside it), if any. */
export function runsFrom(command: string, folders: string[]): string | undefined {
  const win = process.platform === "win32";
  const cmd = win ? command.toLowerCase().replace(/\//g, "\\") : command;
  return folders.find((f) => {
    const dir = win ? f.toLowerCase().replace(/\//g, "\\").replace(/\\$/, "") : f.replace(/\/$/, "");
    return cmd.includes(dir + (win ? "\\" : "/"));
  });
}

// --- reading the system

export function parsePs(stdout: string): Map<number, Proc> {
  const procs = new Map<number, Proc>();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) procs.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return procs;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` output: pid → ports. */
export function parseLsof(stdout: string): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (port) out.set(pid, (out.get(pid) ?? new Set()).add(port));
    }
  }
  return out;
}

/** `ss -ltnpH` output (Linux without lsof): pid → ports. */
export function parseSs(stdout: string): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const port = Number(cols[3]?.slice(cols[3].lastIndexOf(":") + 1));
    for (const m of line.matchAll(/pid=(\d+)/g)) if (port) out.set(Number(m[1]), (out.get(Number(m[1])) ?? new Set()).add(port));
  }
  return out;
}

const asArray = <T>(x: T | T[] | null | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

async function windowsSystem(): Promise<{ procs: Map<number, Proc>; ports: Map<number, Set<number>> }> {
  const ps = (script: string) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  const [p, l] = await Promise.all([
    ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine,Name | ConvertTo-Json -Compress"),
    ps("Get-NetTCPConnection -State Listen | Select-Object OwningProcess,LocalPort | ConvertTo-Json -Compress"),
  ]);
  const procs = new Map<number, Proc>();
  for (const x of asArray(JSON.parse(p || "[]") as { ProcessId: number; ParentProcessId: number; CommandLine?: string; Name?: string }[])) {
    procs.set(x.ProcessId, { pid: x.ProcessId, ppid: x.ParentProcessId, command: x.CommandLine || x.Name || "" });
  }
  const ports = new Map<number, Set<number>>();
  for (const x of asArray(JSON.parse(l || "[]") as { OwningProcess: number; LocalPort: number }[])) {
    ports.set(x.OwningProcess, (ports.get(x.OwningProcess) ?? new Set()).add(x.LocalPort));
  }
  return { procs, ports };
}

async function unixPorts(): Promise<Map<number, Set<number>>> {
  try {
    return parseLsof(await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"]));
  } catch (e) {
    // Not installed (Linux often has only ss), or exit 1 with no output: nothing listens.
    const missing = /ENOENT/.test((e as Error).message);
    if (missing && process.platform === "linux") return parseSs(await run("ss", ["-ltnpH"]));
    if (!missing && !(e as { stderr?: string }).stderr) return new Map();
    throw e;
  }
}

/** Processes and listening ports right now. Throws when the tools are missing. */
export async function readSystem(): Promise<{ procs: Map<number, Proc>; ports: Map<number, Set<number>> }> {
  if (process.platform === "win32") return windowsSystem();
  const [ps, ports] = await Promise.all([run("ps", ["-eo", "pid=,ppid=,args="]), unixPorts()]);
  return { procs: parsePs(ps), ports };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** SIGTERM, then SIGKILL whatever is left after `graceMs` (on Windows both end the process at once). */
export async function stopPids(pids: number[], graceMs = 8000): Promise<void> {
  for (const p of pids) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      // gone already
    }
  }
  const until = Date.now() + graceMs;
  while (pids.some(alive) && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  for (const p of pids.filter(alive)) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // gone
    }
  }
}
