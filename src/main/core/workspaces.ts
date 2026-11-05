// Repos and workspaces: everything except the Electron glue, so it can be
// tested with plain `node --test`.
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Repo, Result, Workspace } from "../../shared/types.ts";
import { loadRepoConfig, type ResolvedLocalConfig } from "./config.ts";
import * as g from "./git.ts";
import { runScript } from "./scripts.ts";
import { pickStation } from "./stations.ts";
import type { Store } from "./store.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (e: unknown): Result<never> => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

export class Workspaces {
  private store: Store;
  private config: ResolvedLocalConfig;
  /** Folder for setup logs. */
  private logDir: string;

  constructor(store: Store, config: ResolvedLocalConfig, logDir: string) {
    this.store = store;
    this.config = config;
    this.logDir = logDir;
  }

  async addRepo(path: string): Promise<Result<Repo>> {
    try {
      const root = await g.repoRoot(path);
      if (!root) return fail(`${path} is not inside a git repository.`);
      const existing = this.store.get().repos.find((r) => samePath(r.path, root));
      if (existing) return ok(existing);
      const repo: Repo = {
        id: randomUUID(),
        name: basename(root),
        path: root,
        baseRef: await g.defaultBaseRef(root),
        addedAt: new Date().toISOString(),
      };
      this.store.update((s) => ({ ...s, repos: [...s.repos, repo] }));
      return ok(repo);
    } catch (e) {
      return fail(e);
    }
  }

  /** Forgets a repo. Refuses while it has live workspaces; archived ones are forgotten with it. */
  removeRepo(repoId: string): Result<void> {
    const live = this.store.get().workspaces.filter((w) => w.repoId === repoId && !w.archived);
    if (live.length) return fail(`Archive its ${live.length} workspace(s) first.`);
    const gone = new Set(this.store.get().workspaces.filter((w) => w.repoId === repoId).map((w) => w.id));
    this.store.update((s) => ({
      repos: s.repos.filter((r) => r.id !== repoId),
      workspaces: s.workspaces.filter((w) => w.repoId !== repoId),
      chats: s.chats.filter((c) => !gone.has(c.workspaceId)),
    }));
    return ok(undefined);
  }

  async createWorkspace(repoId: string): Promise<Result<Workspace>> {
    const repo = this.store.get().repos.find((r) => r.id === repoId);
    if (!repo) return fail("Unknown repository.");
    try {
      const repoConfig = loadRepoConfig(repo.path);
      await g.fetchOrigin(repo.path).catch(() => {}); // offline is fine: branch from what we have
      const taken = new Set(this.store.get().workspaces.filter((w) => w.repoId === repoId).map((w) => w.name));
      let name = pickStation(taken);
      let branch = this.branchFor(name);
      for (let i = 0; (await g.branchExists(repo.path, branch)) || existsSync(this.pathFor(repo, name)); i++) {
        if (i > 20) return fail("Could not find a free workspace name.");
        taken.add(name);
        name = pickStation(taken);
        branch = this.branchFor(name);
      }
      const path = this.pathFor(repo, name);
      mkdirSync(dirname(path), { recursive: true });
      await g.addWorktree(repo.path, path, branch, repo.baseRef);
      await excludeContextDir(repo.path);
      mkdirSync(join(path, ".context"), { recursive: true });
      for (const rel of repoConfig.copy ?? []) {
        const from = join(repo.path, rel);
        if (existsSync(from)) {
          mkdirSync(dirname(join(path, rel)), { recursive: true });
          copyFileSync(from, join(path, rel));
        }
      }
      const ws: Workspace = {
        id: randomUUID(),
        repoId,
        name,
        branch,
        path,
        baseRef: repo.baseRef,
        createdAt: new Date().toISOString(),
        archived: false,
        setup: repoConfig.setup ? "running" : "none",
      };
      this.store.update((s) => ({ ...s, workspaces: [...s.workspaces, ws] }));
      if (repoConfig.setup) void this.runSetup(ws, repo, repoConfig.setup);
      return ok(ws);
    } catch (e) {
      return fail(e);
    }
  }

  /** Runs the archive script, removes the worktree and keeps the branch. */
  async archiveWorkspace(id: string): Promise<Result<void>> {
    const { ws, repo } = this.find(id);
    if (!ws || !repo) return fail("Unknown workspace.");
    try {
      const archive = loadRepoConfig(repo.path).archive;
      if (archive && existsSync(ws.path)) {
        await runScript(archive, ws.path, this.logFile(ws), this.env(ws, repo), this.config.bashPath);
      }
      if (existsSync(ws.path)) await g.removeWorktree(repo.path, ws.path);
      this.patch(id, { archived: true });
      return ok(undefined);
    } catch (e) {
      return fail(e);
    }
  }

  /** Checks the kept branch out again in the same place. */
  async restoreWorkspace(id: string): Promise<Result<void>> {
    const { ws, repo } = this.find(id);
    if (!ws || !repo) return fail("Unknown workspace.");
    try {
      if (!(await g.branchExists(repo.path, ws.branch))) return fail(`Branch ${ws.branch} no longer exists.`);
      if (existsSync(ws.path)) return fail(`${ws.path} already exists.`);
      mkdirSync(dirname(ws.path), { recursive: true });
      await g.addWorktreeForBranch(repo.path, ws.path, ws.branch);
      mkdirSync(join(ws.path, ".context"), { recursive: true });
      const setup = loadRepoConfig(repo.path).setup;
      this.patch(id, { archived: false, setup: setup ? "running" : "none" });
      if (setup) void this.runSetup({ ...ws, archived: false }, repo, setup);
      return ok(undefined);
    } catch (e) {
      return fail(e);
    }
  }

  setupLog(id: string): string {
    const { ws } = this.find(id);
    if (!ws || !existsSync(this.logFile(ws))) return "";
    return readFileSync(this.logFile(ws), "utf8");
  }

  private async runSetup(ws: Workspace, repo: Repo, command: string): Promise<void> {
    mkdirSync(this.logDir, { recursive: true });
    writeFileSync(this.logFile(ws), "");
    try {
      const code = await runScript(command, ws.path, this.logFile(ws), this.env(ws, repo), this.config.bashPath);
      this.patch(ws.id, { setup: code === 0 ? "ok" : "failed" });
    } catch (e) {
      appendFileSync(this.logFile(ws), `\n${(e as Error).message}\n`);
      this.patch(ws.id, { setup: "failed" });
    }
  }

  /** Environment for repo scripts. */
  private env(ws: Workspace, repo: Repo): Record<string, string> {
    return {
      CABOOSE_WORKSPACE_NAME: ws.name,
      CABOOSE_WORKSPACE_PATH: ws.path,
      CABOOSE_ROOT_PATH: repo.path,
      CABOOSE_BRANCH: ws.branch,
    };
  }

  private branchFor(name: string): string {
    return this.config.branchPrefix ? `${this.config.branchPrefix}/${name}` : name;
  }

  private pathFor(repo: Repo, name: string): string {
    return join(this.config.workspacesRoot, repo.name, name);
  }

  private logFile(ws: Workspace): string {
    return join(this.logDir, `setup-${ws.id}.log`);
  }

  private find(id: string): { ws?: Workspace; repo?: Repo } {
    const s = this.store.get();
    const ws = s.workspaces.find((w) => w.id === id);
    return { ws, repo: ws && s.repos.find((r) => r.id === ws.repoId) };
  }

  private patch(id: string, p: Partial<Workspace>): void {
    this.store.update((s) => ({ ...s, workspaces: s.workspaces.map((w) => (w.id === id ? { ...w, ...p } : w)) }));
  }
}

/** Keeps `.context/` out of git in every worktree, without touching the repo's .gitignore. */
async function excludeContextDir(repoPath: string): Promise<void> {
  const exclude = join(await g.commonGitDir(repoPath), "info", "exclude");
  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (current.split(/\r?\n/).includes(".context/")) return;
  mkdirSync(dirname(exclude), { recursive: true });
  appendFileSync(exclude, `${current && !current.endsWith("\n") ? "\n" : ""}.context/\n`);
}

function samePath(a: string, b: string): boolean {
  // git prints C:/x on Windows where Node prints C:\x
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" || process.platform === "darwin"
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
}
