// Features: a station name, a folder, and one git worktree per repo inside it
// (<features root>/<station>/<repo>). Optionally tied to a Jira task, with a
// subtask per repo. Electron-free, tested with plain `node --test`.
import { randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  ArchivedFeature,
  Feature,
  FeatureDetails,
  FeatureJira,
  FeatureRepo,
  FeatureStatus,
  JiraAlignment,
  NewFeature,
  RepoEntry,
  RepoScripts,
  Result,
} from "../../shared/types.ts";
import { type Effective, featureRoots, forLine, loadRepoConfig, type ResolvedLocalConfig } from "./config.ts";
import * as g from "./git.ts";
import { type Jira, leadingKey, parseKey, readFeatureJira, writeFeatureJira } from "./jira.ts";
import { copyLocalFiles, DEFAULT_LOCAL_FILES, findLocalFiles } from "./localfiles.ts";
import { servesLine } from "../../shared/lines.ts";
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
  /** A Jira client for a line (its own Jira, or the general one); null when that is off or not set up. */
  private jira: (line?: string) => Jira | null;

  constructor(store: Store, config: ResolvedLocalConfig, logDir: string, jira: (line?: string) => Jira | null = () => null) {
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

  /** `carry`: what a continued feature brings along (its Jira subtasks, where it came from). */
  async create(input: NewFeature, carry: { subtasks?: Record<string, string>; continuedFrom?: Feature["continuedFrom"] } = {}): Promise<Result<Feature>> {
    try {
      const repos = (input.repos ?? []).map((name) => this.repoEntry(name));
      // No line chosen: the line of the first repo on one (so its folder and Jira are the line's from the start).
      const line = input.line?.trim() || repos.find((r) => r.line)?.line;
      const eff = this.eff(line);
      const off = repos.filter((r) => !servesLine(r, line));
      if (off.length) return fail(`${off.map((r) => `${r.name} is on the ${r.line} line`).join(", ")}; this feature is on ${line}.`);
      const level = eff.jira.level;
      // No task given, but the description starts with a key ("NWP-8259 Feature toggle…"): that is the task,
      // if Jira knows it ("UTF-8 everywhere" starts with something that only looks like a key).
      if (!input.jira && level !== "off") {
        const key = leadingKey(input.text ?? input.title ?? "");
        const j = key ? this.jira(line) : null;
        if (key && (!j || (await j.issue(key).then(() => true, () => false)))) input = { ...input, jira: { key } };
      }
      if (level === "required" && !input.jira) return fail("Jira is required: link a task or create one.");

      // The task first: a failed Jira call should not leave a half-made feature.
      let task: string | undefined;
      let taskSummary = "";
      if (input.jira && level !== "off") {
        if ("key" in input.jira) {
          task = parseKey(input.jira.key) ?? undefined;
          if (!task) return fail(`"${input.jira.key}" is not a Jira key.`);
          const j = this.jira(line);
          if (j) taskSummary = (await j.issue(task)).summary;
        } else {
          const j = this.requireJira(line);
          if (!eff.jira.project) return fail(`Set the Jira project in Configure${line ? ` (the ${line} line)` : ""} to create tasks.`);
          taskSummary = input.jira.create.trim();
          if (!taskSummary) return fail("Give the new Jira task a summary.");
          task = await j.createTask(eff.jira.project, taskSummary);
        }
      }

      const name = this.freeName();
      const folder = join(eff.featuresRoot, name);
      mkdirSync(join(folder, ".context"), { recursive: true });
      if (task) writeFeatureJira(folder, { task, subtasks: carry.subtasks ?? {} });
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
        ...(line ? { line } : {}),
        ...(carry.continuedFrom ? { continuedFrom: carry.continuedFrom } : {}),
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
      if (!servesLine(repo, f.line)) return fail(`${repo.name} is on the ${repo.line} line, and this feature is on ${f.line}: a feature never mixes lines.`);
      const root = await g.repoRoot(repo.path);
      if (!root) return fail(`${repo.path} is not a git repository.`);

      // With a Jira task, every repo gets its own subtask, and its key goes in the branch.
      const jira = readFeatureJira(f.folder);
      const line = f.line ?? repo.line;
      const level = this.eff(line).jira.level;
      if (jira.task && !jira.subtasks[repo.name] && level !== "off") {
        const j = level === "required" ? this.requireJira(line) : this.jira(line);
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
      // A feature on no line takes the line of its first repo that has one.
      this.patch(featureId, (x) => ({ ...x, repos: [...x.repos, fr], ...(!x.line && repo.line ? { line: repo.line } : {}) }));
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

  /** Runs a repo's archive script, if it has one, logging to its setup log. */
  async runArchiveScript(featureId: string, r: FeatureRepo): Promise<void> {
    const f = this.get(featureId);
    const archive = this.scriptsFor(r.name, r.source).archive;
    if (!f || !archive || !existsSync(r.path)) return;
    const code = await runScript(archive, r.path, this.logFile(f, r.name), this.scriptEnv(featureId, r.name), this.config.bashPath);
    if (code !== 0) throw new Error(`exited with code ${code} (see logs/setup-${r.name}.log)`);
  }

  /** The feature's setup/archive logs: [file name, text]. */
  logs(featureId: string): [string, string][] {
    const f = this.get(featureId);
    if (!f) return [];
    return f.repos.flatMap((r): [string, string][] =>
      existsSync(this.logFile(f, r.name)) ? [[`setup-${r.name}.log`, readFileSync(this.logFile(f, r.name), "utf8")]] : [],
    );
  }

  /** Forgets an archived or deleted feature: its record, review comments and logs. */
  forget(featureId: string): void {
    const f = this.get(featureId);
    if (!f) return;
    for (const r of f.repos) rmSync(this.logFile(f, r.name), { force: true });
    this.store.update((s) => ({ ...s, features: s.features.filter((x) => x.id !== featureId), comments: s.comments.filter((c) => c.featureId !== featureId) }));
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

  /** A new task in the line's Jira project, linked to the feature (which gives every repo its subtask). */
  async createTask(featureId: string, summary: string): Promise<Result<JiraAlignment & { task: string }>> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    if (!summary.trim()) return fail("Give the new Jira task a summary.");
    try {
      const j = this.requireJira(f.line);
      const project = this.eff(f.line).jira.project;
      if (!project) return fail(`Set the Jira project in Configure${f.line ? ` (the ${f.line} line)` : ""} to create tasks.`);
      const task = await j.createTask(project, summary.trim());
      const r = await this.setTask(featureId, task);
      return r.ok ? ok({ ...r.value, task }) : fail(`Created ${task}, but: ${r.error}`);
    } catch (e) {
      return fail(e);
    }
  }

  /** Subtasks for repos without one (if Jira is connected), then keys into unpushed branches. */
  async alignWithJira(featureId: string, only?: string): Promise<Result<JiraAlignment>> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    const out: JiraAlignment = { created: [], renamed: [], skipped: [] };
    try {
      const jira = readFeatureJira(f.folder);
      if (!jira.task) return fail("Link the feature to a Jira task first.");
      const j = this.jira(f.line);
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

  setDetails(featureId: string, details: FeatureDetails): Result<void> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    const line = details.line === undefined ? undefined : details.line?.trim() || null;
    if (line) {
      const off = f.repos.filter((r) => !servesLine(this.config.repos.find((x) => x.name === r.name) ?? {}, line));
      if (off.length) return fail(`${off.map((r) => r.name).join(", ")} ${off.length === 1 ? "is" : "are"} on another line.`);
    }
    this.patch(featureId, (f) => {
      const { line: _old, ...rest } = f;
      return {
        ...(line === undefined ? f : line === null ? rest : { ...rest, line }),
        ...(details.title !== undefined ? { title: details.title.trim() || undefined } : {}),
        ...(details.status ? { status: details.status } : {}),
      };
    });
    return ok(undefined);
  }

  /**
   * A new feature carrying on an archived one: the chosen repos (fresh
   * branches from their base: the old ones were deleted), the same line,
   * title and Jira task (and the repos' subtasks), its brief, plan and
   * per-repo briefs, its log with a note, and every chat's transcript in
   * history/ for the agents to read. The chats themselves are carried over by
   * the caller (Chats).
   */
  async continueFrom(a: ArchivedFeature, opts: { repos: string[]; title?: string }): Promise<Result<Feature>> {
    const known = opts.repos.filter((r) => this.config.repos.some((x) => x.name === r));
    const jira = readFeatureJira(a.folder);
    const level = this.eff(a.line).jira.level;
    const r = await this.create(
      {
        repos: known,
        ...(a.line ? { line: a.line } : {}),
        ...((opts.title ?? a.title) ? { title: opts.title ?? a.title } : {}),
        ...(jira.task && level !== "off" ? { jira: { key: jira.task } } : {}),
      },
      {
        subtasks: Object.fromEntries(Object.entries(jira.subtasks).filter(([repo]) => known.includes(repo))),
        continuedFrom: { name: a.name, folder: a.folder, archivedAt: a.archivedAt },
      },
    );
    if (!r.ok) return r;
    const to = r.value.folder;
    const copy = (rel: string) => {
      const from = join(a.folder, rel);
      if (existsSync(from) && !existsSync(join(to, rel))) cpSync(from, join(to, rel), { recursive: true });
    };
    for (const rel of ["brief.md", "plan.md", "briefs"]) copy(rel);
    // Every chat's transcript, as the agents' way back into the conversation.
    if (existsSync(join(a.folder, "chats"))) {
      mkdirSync(join(to, "history"), { recursive: true });
      for (const f of readdirSync(join(a.folder, "chats")).filter((n) => n.endsWith(".md"))) cpSync(join(a.folder, "chats", f), join(to, "history", f));
    }
    const old = existsSync(join(a.folder, "log.md")) ? readFileSync(join(a.folder, "log.md"), "utf8") : "";
    const note = `\n- ${new Date().toISOString().slice(0, 16).replace("T", " ")} caboose: Continues ${a.name} (archived ${a.archivedAt.slice(0, 10)}, ${a.folder}). Its chats are in history/.\n`;
    const current = existsSync(join(to, "log.md")) ? readFileSync(join(to, "log.md"), "utf8") : "";
    writeFileSync(join(to, "log.md"), `${old.trimEnd()}${old ? "\n" : ""}${current}${note}`);
    return ok(this.get(r.value.id)!);
  }

  /** Which components (monikers) of a repo the feature touches; null or [] = all of them. */
  setComponents(featureId: string, repo: string, components: string[] | null): Result<void> {
    const f = this.get(featureId);
    if (!f) return fail("Unknown feature.");
    if (!f.repos.some((r) => r.name === repo)) return fail(`${repo} is not in this feature.`);
    const list = [...new Set((components ?? []).map((c) => c.trim()).filter(Boolean))].sort();
    this.patch(featureId, (x) => {
      const { [repo]: _old, ...others } = x.components ?? {};
      const next = list.length ? { ...others, [repo]: list } : others;
      const { components: _c, ...rest } = x;
      return Object.keys(next).length ? { ...rest, components: next } : rest;
    });
    return ok(undefined);
  }

  /** `<prefix>/<KEY>-<station>` with a Jira key, else `<prefix>/<station>`. */
  private branchName(f: Feature, key?: string): string {
    return `${this.eff(f.line).branchPrefix}/${key ? `${key}-` : ""}${f.name}`;
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
      this.requireJira(this.get(featureId)?.line);
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

  private requireJira(line?: string): Jira {
    const j = this.jira(line);
    if (!j) throw new Error(`Jira is not set up${line && this.config.lines[line]?.jira ? ` for the ${line} line` : ""}: add the site, email and API token in Configure.`);
    return j;
  }

  /** The settings a feature on `line` works with. */
  private eff(line?: string): Effective {
    return forLine(this.config, line);
  }

  /** A station no feature has used (live or ended) and with no folder of that name. */
  private freeName(): string {
    const s = this.store.get();
    // Stations of ended features too: each feature gets a new dot on the map, and names keep spreading from home.
    const taken = new Set([...s.features.map((f) => f.name), ...s.visits.map((v) => v.station)]);
    for (const root of featureRoots(this.config)) if (existsSync(root)) for (const d of readdirSync(root)) taken.add(d);
    return pickStation(taken, this.config.home);
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
