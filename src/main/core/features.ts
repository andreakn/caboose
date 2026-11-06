// Features: a station name, a folder, and one git worktree per repo inside it
// (<features root>/<station>/<repo>). Optionally tied to a Jira task, with a
// subtask per repo. Electron-free, tested with plain `node --test`.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  Feature,
  FeatureJira,
  FeatureRepo,
  FeatureStatus,
  JiraAlignment,
  NewFeature,
  RepoEntry,
  RepoScripts,
  Result,
} from "../../shared/types.ts";
import { loadRepoConfig, type ResolvedLocalConfig } from "./config.ts";
import * as g from "./git.ts";
import { type Jira, parseKey, readFeatureJira, writeFeatureJira } from "./jira.ts";
import { copyLocalFiles, DEFAULT_LOCAL_FILES, findLocalFiles } from "./localfiles.ts";
import { runScript } from "./scripts.ts";
import { pickStation } from "./stations.ts";
import type { Store } from "./store.ts";

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (e: unknown): Result<never> => ({ ok: false, error: e instanceof Error ? e.message : String(e) });

/** Ports per feature; each repo in it gets a block of 10. */
const PORTS_PER_FEATURE = 100;
const FIRST_PORT = 41000;

export class Features {
  private store: Store;
  private config: ResolvedLocalConfig;
  private logDir: string;
  /** A Jira client when Jira is configured with a token, else null. */
  private jira: () => Jira | null;

  constructor(store: Store, config: ResolvedLocalConfig, logDir: string, jira: () => Jira | null = () => null) {
    this.store = store;
    this.config = config;
    this.logDir = logDir;
    this.jira = jira;
  }

  setConfig(config: ResolvedLocalConfig): void {
    this.config = config;
  }

  get(id: string): Feature | undefined {
    return this.store.get().features.find((f) => f.id === id);
  }

  async create(input: NewFeature): Promise<Result<Feature>> {
    try {
      const repos = input.repos.map((name) => this.repoEntry(name));
      if (!repos.length) return fail("Pick at least one repository.");
      const level = this.config.jira.level;
      if (level === "required" && !input.jira) return fail("Jira is required: link a task or create one.");

      // The task first: a failed Jira call should not leave a half-made feature.
      let task: string | undefined;
      let taskSummary = "";
      if (input.jira && level !== "off") {
        if ("key" in input.jira) {
          task = parseKey(input.jira.key) ?? undefined;
          if (!task) return fail(`"${input.jira.key}" is not a Jira key.`);
          const j = this.jira();
          if (j) taskSummary = (await j.issue(task)).summary;
        } else {
          const j = this.requireJira();
          if (!this.config.jira.project) return fail("Set the Jira project in Configure to create tasks.");
          taskSummary = input.jira.create.trim();
          if (!taskSummary) return fail("Give the new Jira task a summary.");
          task = await j.createTask(this.config.jira.project, taskSummary);
        }
      }

      const name = this.freeName();
      const folder = join(this.config.featuresRoot, name);
      mkdirSync(join(folder, ".context"), { recursive: true });
      if (task) writeFeatureJira(folder, { task, subtasks: {} });
      const feature: Feature = {
        id: randomUUID(),
        name,
        folder,
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
        status: "active",
        createdAt: new Date().toISOString(),
        archived: false,
        port: this.freePort(),
        repos: [],
      };
      this.store.update((s) => ({ ...s, features: [...s.features, feature] }));
      for (const repo of repos) {
        const r = await this.addRepo(feature.id, repo.name, taskSummary);
        if (!r.ok) return fail(`${repo.name}: ${r.error}`);
      }
      return ok(this.get(feature.id)!);
    } catch (e) {
      return fail(e);
    }
  }

  /** Adds a repo's worktree to the feature (and its subtask, when Jira is required). */
  async addRepo(featureId: string, repoName: string, taskSummary?: string): Promise<Result<void>> {
    const f = this.get(featureId);
    if (!f || f.archived) return fail("Unknown or archived feature.");
    if (f.repos.some((r) => r.name === repoName)) return fail(`${repoName} is already in this feature.`);
    try {
      const repo = this.repoEntry(repoName);
      const root = await g.repoRoot(repo.path);
      if (!root) return fail(`${repo.path} is not a git repository.`);

      // With a Jira task, every repo gets its own subtask, and its key goes in the branch.
      const jira = readFeatureJira(f.folder);
      if (jira.task && !jira.subtasks[repo.name] && this.config.jira.level !== "off") {
        const j = this.config.jira.level === "required" ? this.requireJira() : this.jira();
        if (j) {
          const summary = taskSummary || (await j.issue(jira.task)).summary;
          jira.subtasks[repo.name] = await j.createSubtask(jira.task, `${repo.name}: ${summary}`);
          writeFeatureJira(f.folder, jira);
        }
      }
      const key = jira.subtasks[repo.name] ?? jira.task;

      await g.fetchOrigin(root).catch(() => {}); // offline is fine: branch from what we have
      const baseRef = await g.defaultBaseRef(root);
      const branch = await this.freeBranch(root, this.branchName(f, key));
      const path = join(f.folder, repo.name);
      if (existsSync(path)) return fail(`${path} already exists.`);
      await g.addWorktree(root, path, branch, baseRef);

      // The gitignored files it needs to run (.env, *.local.*), before setup runs.
      const scripts = this.scriptsFor(repo.name, root);
      const copied = await findLocalFiles(root, this.localFilePatterns(repo.name, root));
      copyLocalFiles(root, path, copied);
      const fr: FeatureRepo = {
        name: repo.name,
        source: root,
        path,
        branch,
        baseRef,
        setup: scripts.setup ? "running" : "none",
        copied,
      };
      this.patch(featureId, (x) => ({ ...x, repos: [...x.repos, fr] }));
      if (scripts.setup) void this.runSetup(featureId, fr, scripts.setup);
      return ok(undefined);
    } catch (e) {
      return fail(e);
    }
  }

  /** Runs archive scripts, removes the worktrees and keeps the branches and the folder. */
  async archive(featureId: string): Promise<Result<void>> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    try {
      for (const r of f.repos) {
        const archive = this.scriptsFor(r.name, r.source).archive;
        if (archive && existsSync(r.path)) {
          await runScript(archive, r.path, this.logFile(f, r.name), this.scriptEnv(featureId, r.name), this.config.bashPath);
        }
        if (existsSync(r.path)) await g.removeWorktree(r.source, r.path);
      }
      this.patch(featureId, (x) => ({ ...x, archived: true }));
      return ok(undefined);
    } catch (e) {
      return fail(e);
    }
  }

  /** Checks the kept branches out again in the same places. */
  async restore(featureId: string): Promise<Result<void>> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    try {
      for (const r of f.repos) {
        if (!(await g.branchExists(r.source, r.branch))) return fail(`Branch ${r.branch} no longer exists in ${r.name}.`);
        if (existsSync(r.path)) return fail(`${r.path} already exists.`);
      }
      mkdirSync(join(f.folder, ".context"), { recursive: true });
      for (const r of f.repos) await g.addWorktreeForBranch(r.source, r.path, r.branch);
      this.patch(featureId, (x) => ({
        ...x,
        archived: false,
        port: this.freePort(featureId),
        repos: x.repos.map((r) => ({ ...r, setup: this.scriptsFor(r.name, r.source).setup ? "running" : "none" })),
      }));
      for (const r of this.get(featureId)!.repos) {
        const setup = this.scriptsFor(r.name, r.source).setup;
        if (setup) void this.runSetup(featureId, r, setup);
      }
      return ok(undefined);
    } catch (e) {
      return fail(e);
    }
  }

  /** Copies the repo's local files from its main checkout again (they changed there), overwriting. */
  async copyLocalFilesAgain(featureId: string, repoName: string): Promise<Result<string[]>> {
    const f = this.get(featureId);
    const r = f?.repos.find((x) => x.name === repoName);
    if (!f || !r || f.archived) return fail("Unknown or archived feature.");
    try {
      const files = await findLocalFiles(r.source, this.localFilePatterns(r.name, r.source));
      copyLocalFiles(r.source, r.path, files);
      this.patch(featureId, (x) => ({ ...x, repos: x.repos.map((y) => (y.name === r.name ? { ...y, copied: files } : y)) }));
      return ok(files);
    } catch (e) {
      return fail(e);
    }
  }

  /** The repo's patterns from the config (or the defaults), plus any in its own caboose.json. */
  private localFilePatterns(repoName: string, root: string): string[] {
    const configured = this.config.repos.find((r) => r.name === repoName)?.localFiles ?? DEFAULT_LOCAL_FILES;
    let inRepo: string[] = [];
    try {
      inRepo = loadRepoConfig(root).copy ?? [];
    } catch {
      // a broken caboose.json should not stop the feature
    }
    return [...configured, ...inRepo];
  }

  jiraOf(featureId: string): FeatureJira {
    const f = this.get(featureId);
    return f ? readFeatureJira(f.folder) : { subtasks: {} };
  }

  /**
   * Links the feature's task (null unlinks it). Linking makes every repo match:
   * a subtask per repo (when Jira is connected) and its key in the branch name
   * of branches not pushed yet.
   */
  async setTask(featureId: string, key: string | null): Promise<Result<JiraAlignment>> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    const parsed = key === null ? undefined : parseKey(key);
    if (key !== null && !parsed) return fail(`"${key}" is not a Jira key.`);
    writeFeatureJira(f.folder, { ...readFeatureJira(f.folder), task: parsed ?? undefined });
    if (!parsed) return ok({ created: [], renamed: [], skipped: [] });
    return this.alignWithJira(featureId);
  }

  /** Subtasks for repos without one (if Jira is connected), then keys into unpushed branches. */
  async alignWithJira(featureId: string, only?: string): Promise<Result<JiraAlignment>> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    const out: JiraAlignment = { created: [], renamed: [], skipped: [] };
    try {
      const jira = readFeatureJira(f.folder);
      if (!jira.task) return fail("Link the feature to a Jira task first.");
      const j = this.jira();
      const repos = f.repos.filter((r) => !only || r.name === only);
      if (j) {
        let summary: string | undefined;
        for (const r of repos) {
          if (jira.subtasks[r.name]) continue;
          summary ??= (await j.issue(jira.task)).summary;
          jira.subtasks[r.name] = await j.createSubtask(jira.task, `${r.name}: ${summary}`);
          out.created.push(jira.subtasks[r.name]);
          writeFeatureJira(f.folder, jira);
        }
      }
      for (const r of repos) {
        const key = jira.subtasks[r.name] ?? jira.task;
        if (r.branch.includes(key) || f.archived) continue;
        if (await g.hasUpstream(r.path)) {
          out.skipped.push(r.name); // pushed: renaming would cut it off from its PR
          continue;
        }
        const to = await this.freeBranch(r.source, this.branchName(f, key));
        await g.renameBranch(r.path, r.branch, to);
        this.setBranch(featureId, r.name, to);
        out.renamed.push({ repo: r.name, from: r.branch, to });
      }
      return ok(out);
    } catch (e) {
      return out.created.length || out.renamed.length ? ok(out) : fail(e);
    }
  }

  setDetails(featureId: string, details: { title?: string; status?: FeatureStatus }): Result<void> {
    if (!this.get(featureId)) return fail("Unknown feature.");
    this.patch(featureId, (f) => ({
      ...f,
      ...(details.title !== undefined ? { title: details.title.trim() || undefined } : {}),
      ...(details.status ? { status: details.status } : {}),
    }));
    return ok(undefined);
  }

  /** `<prefix>/<KEY>-<station>` with a Jira key, else `<prefix>/<station>`. */
  private branchName(f: Feature, key?: string): string {
    return `${this.config.branchPrefix}/${key ? `${key}-` : ""}${f.name}`;
  }

  /** A repo's scripts: the config's, plus what its caboose.json adds (setup/archive only where the config has none). */
  scriptsFor(repoName: string, root: string): RepoScripts {
    const configured = this.config.repos.find((r) => r.name === repoName)?.scripts ?? {};
    let own: ReturnType<typeof loadRepoConfig> = {};
    try {
      own = loadRepoConfig(root);
    } catch {
      // a broken caboose.json should not stop the feature
    }
    const run = [...(configured.run ?? [])];
    if (own.run && !run.some((r) => r.command === own.run)) run.push({ name: run.some((r) => r.name === "run") ? "caboose.json" : "run", command: own.run });
    return {
      setup: configured.setup || own.setup,
      archive: configured.archive || own.archive,
      ...(run.length ? { run } : {}),
    };
  }

  setSubtask(featureId: string, repo: string, key: string | null): Result<void> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    const j = readFeatureJira(f.folder);
    if (key === null) delete j.subtasks[repo];
    else {
      const parsed = parseKey(key);
      if (!parsed) return fail(`"${key}" is not a Jira key.`);
      j.subtasks[repo] = parsed;
    }
    writeFeatureJira(f.folder, j);
    return ok(undefined);
  }

  /** Creates the repo's subtask and puts its key in the repo's branch (if not pushed yet). */
  async createSubtask(featureId: string, repo: string): Promise<Result<JiraAlignment>> {
    try {
      this.requireJira();
    } catch (e) {
      return fail(e);
    }
    return this.alignWithJira(featureId, repo);
  }

  setBranch(featureId: string, repo: string, branch: string): void {
    this.patch(featureId, (f) => ({ ...f, repos: f.repos.map((r) => (r.name === repo ? { ...r, branch } : r)) }));
  }

  /** Environment for scripts and terminals; `repo` absent = the feature folder. */
  scriptEnv(featureId: string, repo?: string): Record<string, string> {
    const f = this.get(featureId);
    if (!f) return {};
    const i = repo ? f.repos.findIndex((r) => r.name === repo) : -1;
    const r = f.repos[i];
    return {
      CABOOSE_FEATURE: f.name,
      CABOOSE_FEATURE_PATH: f.folder,
      CABOOSE_FEATURE_PORT: String(f.port),
      CABOOSE_PORT: String(f.port + 10 * Math.max(0, i)),
      ...(r
        ? {
            CABOOSE_REPO: r.name,
            CABOOSE_WORKSPACE_PATH: r.path,
            CABOOSE_ROOT_PATH: r.source,
            CABOOSE_BRANCH: r.branch,
          }
        : {}),
    };
  }

  setupLog(featureId: string, repo: string): string {
    const f = this.get(featureId);
    if (!f || !existsSync(this.logFile(f, repo))) return "";
    return readFileSync(this.logFile(f, repo), "utf8");
  }

  private async runSetup(featureId: string, r: FeatureRepo, command: string): Promise<void> {
    const f = this.get(featureId)!;
    mkdirSync(this.logDir, { recursive: true });
    writeFileSync(this.logFile(f, r.name), "");
    const set = (setup: FeatureRepo["setup"]) =>
      this.patch(featureId, (x) => ({ ...x, repos: x.repos.map((y) => (y.name === r.name ? { ...y, setup } : y)) }));
    try {
      const code = await runScript(command, r.path, this.logFile(f, r.name), this.scriptEnv(featureId, r.name), this.config.bashPath);
      set(code === 0 ? "ok" : "failed");
    } catch (e) {
      appendFileSync(this.logFile(f, r.name), `\n${(e as Error).message}\n`);
      set("failed");
    }
  }

  private repoEntry(name: string): RepoEntry {
    const repo = this.config.repos.find((r) => r.name === name);
    if (!repo) throw new Error(`No repository called "${name}" in the config.`);
    return repo;
  }

  private requireJira(): Jira {
    const j = this.jira();
    if (!j) throw new Error("Jira is not set up: add the site, email and API token in Configure.");
    return j;
  }

  /** A station no feature has used and with no folder of that name. */
  private freeName(): string {
    const taken = new Set(this.store.get().features.map((f) => f.name));
    if (existsSync(this.config.featuresRoot)) for (const d of readdirSync(this.config.featuresRoot)) taken.add(d);
    return pickStation(taken);
  }

  private async freeBranch(root: string, wanted: string): Promise<string> {
    let branch = wanted;
    for (let n = 2; await g.branchExists(root, branch); n++) branch = `${wanted}-${n}`;
    return branch;
  }

  /** The lowest free block of ports from 41000, skipping live features' blocks. */
  private freePort(except?: string): number {
    const used = new Set(this.store.get().features.filter((f) => !f.archived && f.id !== except).map((f) => f.port));
    let port = FIRST_PORT;
    while (used.has(port)) port += PORTS_PER_FEATURE;
    return port;
  }

  private logFile(f: Feature, repo: string): string {
    return join(this.logDir, `setup-${f.id}-${repo}.log`);
  }

  private patch(id: string, fn: (f: Feature) => Feature): void {
    this.store.update((s) => ({ ...s, features: s.features.map((f) => (f.id === id ? fn(f) : f)) }));
  }
}

/** The top folder and name of the git repo containing `path`. */
export async function checkRepo(path: string): Promise<Result<RepoEntry>> {
  const root = await g.repoRoot(path);
  return root ? ok({ name: basename(root), path: root }) : fail(`${path} is not inside a git repository.`);
}

/** Git repos directly inside `folder`. */
export function scanRepos(folder: string): RepoEntry[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(folder, d.name, ".git")))
      .map((d) => ({ name: d.name, path: join(folder, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
