// The Run tab: every repo's programs in a feature, started and stopped the
// way cross_conductor did it, but in Caboose's own terminals (any OS) instead
// of iTerm tabs. Stop is Ctrl-C, a grace period, then a hang-up; programs
// listening from a worktree that the Run tab did not start are shown so they
// can be stopped too.
import type { Feature, PortHolder, RepoEntry, RepoScripts, RunOverview, RunScript, Terminal } from "../../shared/types.ts";
import { type Listener, listeners, type Proc, readSystem, runsFrom, stopPids } from "./listeners.ts";
import { monikersOf, readMonikers, runnables } from "./runscripts.ts";
import type { TerminalEnv, Terminals } from "./terminals.ts";

export type System = () => Promise<{ procs: Map<number, Proc>; ports: Map<number, Set<number>> }>;

export type RunnerDeps = {
  terminals: Terminals;
  features: () => Feature[];
  repos: () => RepoEntry[];
  scriptsFor: (repo: string, source: string) => RepoScripts;
  scriptEnv: (featureId: string, repo: string) => Record<string, string>;
  monikersFile: () => string | undefined;
  /** Processes and listening ports (readSystem; replaced in tests). */
  system?: System;
  /** Caboose's own pid. */
  self?: number;
};

/** The port a URL uses, if it is on this machine. */
function localPort(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (!["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(u.hostname)) return undefined;
    return Number(u.port || (u.protocol === "https:" ? 443 : 80));
  } catch {
    return undefined;
  }
}

export class Runner {
  private deps: RunnerDeps;
  private cache: { at: number; value: Promise<Listener[]> } | null = null;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  private feature(featureId: string): Feature {
    const f = this.deps.features().find((x) => x.id === featureId);
    if (!f) throw new Error("Unknown feature.");
    return f;
  }

  private scripts(f: Feature, repo: string) {
    const r = f.repos.find((x) => x.name === repo);
    if (!r) throw new Error(`${repo} is not in this feature.`);
    return { r, list: runnables(r.path, this.deps.scriptsFor(r.name, r.source).run) };
  }

  /** Listening programs, cached for 2 s (polled by the tab; lsof and ps are not free). */
  private listening(fresh = false): Promise<Listener[]> {
    if (!fresh && this.cache && Date.now() - this.cache.at < 2000) return this.cache.value;
    const read = this.deps.system ?? readSystem;
    const value = read().then(({ procs, ports }) => listeners(procs, ports, this.deps.terminals.pids(), this.deps.self ?? process.pid));
    this.cache = { at: Date.now(), value };
    value.catch(() => (this.cache = null));
    return value;
  }

  /** Where a listening program runs from, and whether Caboose may stop it. */
  private holder(l: Listener): PortHolder {
    const base = { pid: l.pid, name: l.name, ports: l.ports, command: l.command };
    if (l.terminalId) {
      const t = this.deps.terminals.list().find((x) => x.id === l.terminalId);
      const f = t && this.deps.features().find((x) => x.id === t.featureId);
      return { ...base, where: f ? `${f.name}: ${t.title}` : "a Caboose terminal", stoppable: true };
    }
    const places = new Map<string, string>();
    for (const f of this.deps.features()) if (!f.archived) for (const r of f.repos) places.set(r.path, `${f.name}/${r.name}`);
    for (const r of this.deps.repos()) places.set(r.path, `${r.name} (main checkout)`);
    const from = runsFrom(l.command, [...places.keys()]);
    return { ...base, ...(from ? { where: places.get(from) } : {}), stoppable: Boolean(from) };
  }

  async overview(featureId: string): Promise<RunOverview> {
    const f = this.feature(featureId);
    const monikers = readMonikers(this.deps.monikersFile());
    const terms = this.deps.terminals.list(f.id).filter((t) => t.kind === "run");
    let all: Listener[] = [];
    let strayError: string | undefined;
    try {
      all = await this.listening();
    } catch (e) {
      strayError = (e as Error).message;
    }
    const repos = f.repos.map((r) => {
      const names = monikersOf(monikers, r.source);
      const scripts = runnables(r.path, this.deps.scriptsFor(r.name, r.source).run).map((s): RunScript => {
        const t = terms.find((x) => x.repo === r.name && x.script === s.id);
        const state = !t ? "stopped" : t.exitCode === undefined ? "running" : "exited";
        const ports = s.urls.map((u) => localPort(u.url)).filter((p): p is number => p !== undefined);
        const busy = state === "running" ? [] : all.filter((l) => l.ports.some((p) => ports.includes(p))).map((l) => this.holder(l));
        const description = s.id.startsWith("config:") ? undefined : names.describe(s.moniker);
        return {
          id: s.id,
          label: s.label,
          ...(description ? { description } : {}),
          command: s.command,
          urls: s.urls,
          state,
          ...(t ? { terminalId: t.id } : {}),
          ...(t?.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
          ...(busy.length ? { busy } : {}),
        };
      });
      const strays = all.filter((l) => !l.terminalId && runsFrom(l.command, [r.path])).map((l) => this.holder(l));
      return {
        repo: r.name,
        path: r.path,
        ...(names.moniker ? { moniker: names.moniker } : {}),
        ...(names.description ? { description: names.description } : {}),
        scripts,
        strays,
      };
    });
    return { repos, ...(strayError ? { strayError } : {}) };
  }

  /** Starts one script (absent: the repo's first) in a terminal; a running one is left alone. */
  async start(featureId: string, repo: string, id?: string): Promise<Terminal> {
    const f = this.feature(featureId);
    if (f.archived) throw new Error("This feature is archived.");
    const { r, list } = this.scripts(f, repo);
    const s = id ? list.find((x) => x.id === id) : list[0];
    if (!s) throw new Error(id ? `${repo} has no run script ${id}.` : `${repo} has no run.sh or run_*.sh, and no run script in Configure.`);
    const running = this.deps.terminals.list(f.id).find((t) => t.kind === "run" && t.repo === r.name && t.script === s.id && t.exitCode === undefined);
    if (running) return running;
    const where: TerminalEnv = { cwd: r.path, env: this.deps.scriptEnv(f.id, r.name) };
    this.cache = null;
    return this.deps.terminals.run(f.id, r.name, s.command, where, s.id, s.label);
  }

  /** Starts every script that is not running: one repo's, or the whole feature's. Returns how many. */
  async startAll(featureId: string, repo?: string): Promise<number> {
    const f = this.feature(featureId);
    let n = 0;
    for (const r of f.repos.filter((x) => !repo || x.name === repo)) {
      for (const s of this.scripts(f, r.name).list) {
        const running = this.deps.terminals.list(f.id).some((t) => t.repo === r.name && t.script === s.id && t.exitCode === undefined);
        if (running) continue;
        await this.start(f.id, r.name, s.id);
        n++;
      }
    }
    return n;
  }

  /** Ctrl-C, wait, hang up; then the terminal is closed (an exited one just closes). */
  async stop(terminalId: string, graceMs?: number): Promise<void> {
    await this.deps.terminals.stop(terminalId, graceMs);
    this.deps.terminals.close(terminalId);
    this.cache = null;
  }

  async stopAll(featureId: string, graceMs?: number): Promise<void> {
    const runs = this.deps.terminals.list(featureId).filter((t) => t.kind === "run");
    await Promise.all(runs.map((t) => this.stop(t.id, graceMs)));
  }

  /** Stops a program holding a port: through its terminal if it is in one, else SIGTERM/SIGKILL (with its launchers). */
  async stopHolder(featureId: string, pid: number, graceMs?: number): Promise<void> {
    this.feature(featureId);
    const l = (await this.listening(true)).find((x) => x.pid === pid);
    if (!l) throw new Error(`Nothing listens as pid ${pid} any more.`);
    if (!this.holder(l).stoppable) throw new Error(`${l.name} (pid ${pid}) does not run from a folder Caboose knows; stop it yourself.`);
    if (l.terminalId) {
      const t = this.deps.terminals.list().find((x) => x.id === l.terminalId);
      if (t?.kind === "run") await this.stop(t.id, graceMs);
      else await this.deps.terminals.stop(l.terminalId, graceMs);
    } else {
      await stopPids([l.pid, ...l.wrappers], graceMs);
    }
    this.cache = null;
  }

  /** The URL, if that script declares it (nothing else is opened). */
  browseUrl(featureId: string, repo: string, id: string, url: string): string {
    const hit = this.scripts(this.feature(featureId), repo).list.find((x) => x.id === id)?.urls.find((u) => u.url === url);
    if (!hit) throw new Error(`${id} does not declare ${url}`);
    return hit.url;
  }
}
