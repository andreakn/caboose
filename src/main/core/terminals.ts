// Terminals per workspace: interactive shells and the repo's run script, in
// real ptys (prebuilt node-pty, nothing to compile). In memory only: they end
// when the app quits.
import { type IPty, spawn } from "@lydell/node-pty";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Terminal } from "../../shared/types.ts";
import { findBash } from "./scripts.ts";

const MAX_BUFFER = 256 * 1024;

type Entry = Terminal & { pty: IPty; buffer: string };

export type TerminalEnv = { cwd: string; env: Record<string, string> };

export class Terminals {
  private entries = new Map<string, Entry>();
  private emitData: (id: string, data: string) => void;
  private emitList: () => void;
  private bashPath?: string;
  private shellPath?: string;

  constructor(opts: {
    onData: (id: string, data: string) => void;
    onChange: () => void;
    bashPath?: string;
    shellPath?: string;
  }) {
    this.emitData = opts.onData;
    this.emitList = opts.onChange;
    this.bashPath = opts.bashPath;
    this.shellPath = opts.shellPath;
  }

  setPaths(bashPath?: string, shellPath?: string): void {
    this.bashPath = bashPath;
    this.shellPath = shellPath;
  }

  list(workspaceId?: string): Terminal[] {
    return [...this.entries.values()]
      .filter((t) => !workspaceId || t.workspaceId === workspaceId)
      .map(({ pty: _p, buffer: _b, ...t }) => t);
  }

  /** An interactive shell in the workspace. */
  openShell(workspaceId: string, where: TerminalEnv): Terminal {
    const [file, args] = defaultShell(this.shellPath);
    const n = this.list(workspaceId).filter((t) => t.kind === "shell").length + 1;
    return this.start(workspaceId, "shell", n === 1 ? "Terminal" : `Terminal ${n}`, file, args, where);
  }

  /** Runs `command` through bash (Git Bash on Windows), replacing a previous run. */
  async run(workspaceId: string, command: string, where: TerminalEnv): Promise<Terminal> {
    const old = this.list(workspaceId).find((t) => t.kind === "run");
    if (old) this.close(old.id);
    const bash = await findBash(this.bashPath);
    return this.start(workspaceId, "run", "Run", bash, ["-lc", command], where);
  }

  write(id: string, data: string): void {
    const t = this.entries.get(id);
    if (t && t.exitCode === undefined) t.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.entries.get(id);
    if (t && t.exitCode === undefined && cols > 0 && rows > 0) t.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  /** Everything the terminal has printed (up to 256 KB), escape codes included. */
  buffer(id: string): string {
    return this.entries.get(id)?.buffer ?? "";
  }

  /** The last `lines` lines as plain text, for Claude. */
  output(id: string, lines = 200): string {
    const text = plain(this.buffer(id));
    return text.split("\n").slice(-lines).join("\n");
  }

  /** Stops the process (if running) and forgets the terminal. */
  close(id: string): void {
    const t = this.entries.get(id);
    if (!t) return;
    this.entries.delete(id);
    if (t.exitCode === undefined) kill(t.pty);
    this.emitList();
  }

  /** Stops the process but keeps its output on screen. */
  stop(id: string): void {
    const t = this.entries.get(id);
    if (t && t.exitCode === undefined) kill(t.pty);
  }

  closeWorkspace(workspaceId: string): void {
    for (const t of this.list(workspaceId)) this.close(t.id);
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  private start(
    workspaceId: string,
    kind: Terminal["kind"],
    title: string,
    file: string,
    args: string[],
    where: TerminalEnv,
  ): Terminal {
    const pty = spawn(file, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 24,
      cwd: where.cwd,
      env: { ...process.env, ...where.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
    });
    const entry: Entry = { id: randomUUID(), workspaceId, kind, title, startedAt: new Date().toISOString(), pty, buffer: "" };
    this.entries.set(entry.id, entry);
    pty.onData((d) => {
      entry.buffer += d;
      if (entry.buffer.length > MAX_BUFFER) entry.buffer = entry.buffer.slice(-MAX_BUFFER);
      this.emitData(entry.id, d);
    });
    pty.onExit(({ exitCode }) => {
      entry.exitCode = exitCode;
      const note = `\r\n\x1b[2m[process exited with code ${exitCode}]\x1b[0m\r\n`;
      entry.buffer += note;
      if (this.entries.has(entry.id)) {
        this.emitData(entry.id, note);
        this.emitList();
      }
    });
    this.emitList();
    const { pty: _p, buffer: _b, ...t } = entry;
    return t;
  }
}

/** The user's shell: $SHELL on macOS/Linux, PowerShell on Windows, unless caboose.local.json says otherwise. */
function defaultShell(configured?: string): [string, string[]] {
  if (configured) return [configured, []];
  if (process.platform === "win32") {
    const pwsh = ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"].find((p) => existsSync(p));
    return [pwsh ?? "powershell.exe", ["-NoLogo"]];
  }
  return [process.env.SHELL || "/bin/bash", ["-l"]];
}

function kill(pty: IPty): void {
  try {
    // On macOS/Linux this hangs up the whole process group (the shell and
    // whatever it started); on Windows closing the ConPTY ends its processes.
    pty.kill();
  } catch {
    // already gone
  }
}

/** Terminal output without escape codes, with \r\n → \n and overwritten lines collapsed. */
export function plain(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC (titles, links)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI (colours, cursor)
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\r").at(-1) ?? "") // progress bars: keep what was drawn last
    .join("\n");
}
