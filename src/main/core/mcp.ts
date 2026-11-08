// Caboose's own tools for the agents: for Claude an in-process MCP server
// ("caboose", seen as mcp__caboose__<Name>), for Copilot SDK tools
// (caboose_<name>). One table (TOOLS) defines both. The diff/comment/terminal
// tools cover every repo in the feature (`repo` narrows them); the
// coordination tools let the central chat break out and steer repo chats, and
// every chat report status and notes to the feature's log.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { type Agent, type Chat } from "../../shared/chat.ts";
import { type Feature, type FeatureRepo, REPO_STATUSES, type RepoEntry, type RepoStatus, type RunOverview, type RunRepo, type RunScript, type Terminal } from "../../shared/types.ts";
import type { Comments } from "./comments.ts";
import type { Coordinator } from "./coordination.ts";
import { changes, fullPatch } from "./diff.ts";
import { readFeatureJira } from "./jira.ts";

const MAX_CHARS = 100_000;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** What GetTerminalOutput needs from the terminal manager. */
export type TerminalSource = { list(featureId: string): Terminal[]; output(id: string, lines?: number): string };

/** What the program tools need from the Run tab's runner. */
export type ProgramRunner = {
  overview(featureId: string): Promise<RunOverview>;
  start(featureId: string, repo: string, id?: string): Promise<Terminal>;
  stop(terminalId: string): Promise<void>;
};

/** What the tools work on: the feature, the chat that calls them, and the app's services. */
export type ToolContext = {
  feature: () => Feature;
  chat?: () => Chat | undefined;
  comments: Comments;
  terminals?: TerminalSource;
  coord?: Coordinator;
  runner?: ProgramRunner;
};

/** The tool handlers, separate from the MCP wrapper so they can be tested directly. */
export function cabooseHandlers(feature: () => Feature, comments: Comments, terminals?: TerminalSource, ctx: Partial<ToolContext> = {}) {
  const chat = () => ctx.chat?.();
  const coord = ctx.coord;
  const noCoord = "Coordination is not available here.";
  /** The feature's repos, or the one named (error text if unknown). */
  const reposFor = (repo?: string): FeatureRepo[] | string => {
    const all = feature().repos;
    if (!repo) return all;
    const r = all.find((x) => x.name === repo);
    return r ? [r] : `No repo "${repo}" in this feature. Its repos: ${all.map((x) => x.name).join(", ")}.`;
  };

  const runner = ctx.runner;
  const noRunner = "Programs cannot be run from here.";
  /** The repo a program tool is about: as named, else the repo chat's own, else the only one. */
  const programRepo = (repo?: string): string | { error: string } => {
    const names = feature().repos.map((r) => r.name);
    const pick = repo ?? chat()?.repo ?? (names.length === 1 ? names[0] : undefined);
    if (!pick) return { error: `Say which repo: ${names.join(", ")}.` };
    return names.includes(pick) ? pick : { error: `No repo "${pick}" in this feature. Its repos: ${names.join(", ")}.` };
  };
  /** A repo's program by its name (run_<name>.sh, "run", or a configured name), or its only one. */
  const findProgram = (r: RunRepo, program?: string): RunScript | string => {
    if (!r.scripts.length) return `${r.repo} has no programs (no run.sh or run_*.sh, and none in Configure).`;
    if (!program) return r.scripts.length === 1 || !r.scripts.some((s) => s.state === "running") ? r.scripts[0] : r.scripts.find((s) => s.state === "running")!;
    const p = program.toLowerCase();
    return (
      r.scripts.find((s) => s.id.toLowerCase() === p || s.label.toLowerCase() === p || s.id.toLowerCase() === `run_${p}.sh` || s.id === `config:${program}`) ??
      `${r.repo} has no program "${program}". It has: ${r.scripts.map((s) => s.label).join(", ")}.`
    );
  };
  const describeProgram = (s: RunScript) =>
    [
      `${s.label} (${s.id.startsWith("config:") ? s.command : s.id}): ${s.state === "exited" ? `exited with code ${s.exitCode}` : s.state}`,
      s.urls.length ? `urls ${s.urls.map((u) => u.url).join(" ")}` : "",
      ...(s.busy ?? []).map((h) => `⚠ port ${h.ports.join(",")} is taken by ${h.name}${h.where ? ` (${h.where})` : ""}`),
      ...(s.elsewhere ?? []).map((e) => `⚠ also running in feature ${e.feature} (probably holding its port)`),
    ]
      .filter(Boolean)
      .join("; ");

  return {
    async listPrograms(args: { repo?: string }): Promise<string> {
      if (!runner) return noRunner;
      const ov = await runner.overview(feature().id);
      const repos = ov.repos.filter((r) => !args.repo || r.repo === args.repo);
      if (!repos.length) return args.repo ? `No repo "${args.repo}" in this feature.` : "This feature has no repos yet.";
      return repos
        .map((r) => `${r.repo}:\n${r.scripts.length ? r.scripts.map((s) => `- ${describeProgram(s)}`).join("\n") : "- no programs"}${r.strays.map((h) => `\n- ⚠ running outside the Run tab: ${h.name} on port ${h.ports.join(",")} (pid ${h.pid})`).join("")}`)
        .join("\n\n");
    },

    async startProgram(args: { repo?: string; program?: string; wait?: number }): Promise<string> {
      if (!runner) return noRunner;
      const repo = programRepo(args.repo);
      if (typeof repo !== "string") return repo.error;
      const r = (await runner.overview(feature().id)).repos.find((x) => x.repo === repo)!;
      const s = findProgram(r, args.program);
      if (typeof s === "string") return s;
      const warnings = [...(s.busy ?? []).map((h) => `port ${h.ports.join(",")} was already taken by ${h.name}${h.where ? ` (${h.where})` : ""}`), ...(s.elsewhere ?? []).map((e) => `it was already running in feature ${e.feature}`)];
      const t = await runner.start(feature().id, repo, s.id);
      // Wait until it answers on its first URL, exits, or the time is up.
      const url = s.urls[0]?.url;
      // With no URL to check, a few seconds tell whether it starts or falls over at once.
      const waitMs = Math.min(Math.max(args.wait ?? 30, 0), 180) * 1000;
      const deadline = Date.now() + (url ? waitMs : Math.min(waitMs, 5000));
      let answered = "";
      while (Date.now() < deadline) {
        const now = terminals?.list(feature().id).find((x) => x.id === t.id);
        if (now?.exitCode !== undefined) {
          return `${s.label} exited with code ${now.exitCode}.${warnings.length ? ` Before starting: ${warnings.join("; ")}.` : ""}\n\n${terminals?.output(t.id, 60) ?? ""}`;
        }
        if (url) {
          const res = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null);
          if (res) {
            answered = `${url} answers ${res.status}.`;
            break;
          }
        }
        await new Promise((ok) => setTimeout(ok, url ? 1000 : 500));
      }
      const status = answered || (url ? `${url} did not answer yet.` : "It has no URL declared to check.");
      return `${s.label} is running in the user's Run tab (terminal "${t.title}"). ${status}${warnings.length ? `\n⚠ Before starting: ${warnings.join("; ")}.` : ""}\n\nLast output:\n${terminals?.output(t.id, 40) ?? ""}`;
    },

    async stopProgram(args: { repo?: string; program?: string }): Promise<string> {
      if (!runner) return noRunner;
      const repo = programRepo(args.repo);
      if (typeof repo !== "string") return repo.error;
      const r = (await runner.overview(feature().id)).repos.find((x) => x.repo === repo)!;
      const s = findProgram(r, args.program);
      if (typeof s === "string") return s;
      if (!s.terminalId) return `${s.label} is not running.`;
      await runner.stop(s.terminalId);
      return `Stopped ${s.label} (Ctrl-C, then closed).`;
    },

    async fetchLocal(args: { url: string; method?: string; body?: string; headers?: Record<string, string> }): Promise<string> {
      let u: URL;
      try {
        u = new URL(args.url);
      } catch {
        return `Not a URL: ${args.url}`;
      }
      if (!["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) || !/^https?:$/.test(u.protocol)) {
        return "FetchLocal only reaches programs on this machine (http://localhost:…).";
      }
      try {
        const res = await fetch(u, {
          method: args.method ?? "GET",
          headers: args.headers,
          body: args.body,
          signal: AbortSignal.timeout(15_000),
          redirect: "manual",
        });
        const body = await res.text();
        const type = res.headers.get("content-type") ?? "";
        return `${res.status} ${res.statusText}${type ? ` (${type})` : ""}\n\n${body.length > 6000 ? `${body.slice(0, 6000)}\n… (${body.length} characters in all)` : body}`;
      } catch (e) {
        return `No answer from ${u.href}: ${(e as Error).message}`;
      }
    },

    getTerminalOutput(args: { terminal?: string; lines?: number }): string {
      const list = terminals?.list(feature().id) ?? [];
      if (!list.length) return "No terminals are open in this feature. The user starts them in Caboose (Run, or a terminal tab).";
      const want = args.terminal?.toLowerCase();
      // A repo name means its run script; then exact ids and titles.
      const t =
        list.find((x) => x.kind === "run" && want && (x.repo === want || `run ${x.repo}` === want)) ??
        list.find((x) => x.id === args.terminal || x.title.toLowerCase() === want) ??
        (want === "run" || !want ? list.find((x) => x.kind === "run") : undefined) ??
        list.at(-1)!;
      const state = t.exitCode === undefined ? "running" : `exited with code ${t.exitCode}`;
      const names = list.map((x) => x.title).join(", ");
      return `Terminal "${t.title}" (${state}; open terminals: ${names})\n\n${terminals!.output(t.id, Math.min(args.lines ?? 200, 2000))}`;
    },

    async getWorkspaceDiff(args: { repo?: string; path?: string; stat?: boolean }): Promise<string> {
      const repos = reposFor(args.repo);
      if (typeof repos === "string") return repos;
      const parts: string[] = [];
      for (const r of repos) {
        if (args.stat) {
          const c = await changes(r.path, r.baseRef);
          const lines = c.files.map(
            (f) => `  ${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}`,
          );
          parts.push(`${r.name} (${r.branch} vs ${r.baseRef}):\n${lines.join("\n") || "  no changes"}`);
        } else {
          const patch = await fullPatch(r.path, r.baseRef, args.path);
          if (patch.trim()) parts.push(`### ${r.name}\n${patch}`);
        }
      }
      const out = parts.join("\n\n");
      if (!out.trim()) return args.path ? `No changes to ${args.path}.` : "No changes in this feature yet.";
      return out.length > MAX_CHARS
        ? `${out.slice(0, MAX_CHARS)}\n… truncated (${out.length - MAX_CHARS} more characters). Ask for one repo with \`repo\`, or one file with \`path\`.`
        : out;
    },

    diffComment(args: { comments: { repo?: string; file: string; line: number; body: string; lineText?: string }[] }): string {
      const all = feature().repos;
      for (const c of args.comments) {
        const repo = c.repo ?? (all.length === 1 ? all[0].name : undefined);
        if (!repo || !all.some((r) => r.name === repo)) {
          return `Say which repo each comment is in (one of: ${all.map((r) => r.name).join(", ")}).`;
        }
      }
      for (const c of args.comments) {
        comments.add({
          featureId: feature().id,
          repo: c.repo ?? all[0].name,
          file: c.file,
          line: c.line,
          side: "new",
          lineText: c.lineText ?? "",
          body: c.body,
          author: "claude",
        });
      }
      return `Added ${args.comments.length} comment(s) to the Changes view.`;
    },

    getDiffComments(args: { includeResolved?: boolean }): string {
      const list = comments
        .list(feature().id)
        .filter((c) => c.author === "user" && (args.includeResolved || !c.resolved))
        .map(({ repo, file, line, side, lineText, body, resolved, sentAt }) => ({ repo, file, line, side, lineText, body, resolved, sent: Boolean(sentAt) }));
      return list.length ? JSON.stringify(list, null, 2) : "The user has left no comments.";
    },

    reportStatus(args: { status: RepoStatus; note: string; repo?: string }): string {
      if (!coord) return noCoord;
      const repo = args.repo ?? chat()?.repo;
      if (!repo) return `Say which repo the status is for (one of: ${feature().repos.map((r) => r.name).join(", ")}).`;
      if (!feature().repos.some((r) => r.name === repo)) return `No repo "${repo}" in this feature.`;
      const r = coord.log(feature().id, { from: repo, status: args.status, text: args.note });
      return r.ok ? `Logged: ${repo} is ${args.status}.` : r.error;
    },

    log(args: { text: string }): string {
      if (!coord) return noCoord;
      const r = coord.log(feature().id, { from: chat()?.repo ?? "coordinator", text: args.text });
      return r.ok ? "Logged." : r.error;
    },

    async featureStatus(): Promise<string> {
      return coord ? coord.status(feature().id) : noCoord;
    },

    startRepoChat(args: { repo: string; message: string; agent?: Agent }): string {
      if (!coord) return noCoord;
      const from = chat()?.repo ? `the ${chat()!.repo} agent` : "the coordinator";
      const r = coord.startRepoChat(feature().id, args.repo, args.message, { agent: args.agent ?? chat()?.agent, from });
      return r.ok ? `${args.repo}'s chat has the task and is working on it. Check on it with the repo-chat tool, or the feature status.` : r.error;
    },

    messageRepoChat(args: { repo: string; message: string }): string {
      if (!coord) return noCoord;
      const from = chat()?.repo ? `the ${chat()!.repo} agent` : "the coordinator";
      const r = coord.messageRepoChat(feature().id, args.repo, args.message, from);
      return r.ok ? r.value : r.error;
    },

    getRepoChat(args: { repo: string }): string {
      return coord ? coord.repoChat(feature().id, args.repo) : noCoord;
    },

    proposeRepos(args: { repos: { name: string; reason: string }[] }): string {
      const c = chat();
      if (!coord || !c) return noCoord;
      const r = coord.proposeRepos(feature().id, c.id, args.repos);
      return r.ok ? r.value : r.error;
    },

    setFeatureTitle(args: { title: string }): string {
      if (!coord) return noCoord;
      const r = coord.setTitle(feature().id, args.title);
      return r.ok ? `Title set: ${args.title}` : r.error;
    },
  };
}

type Handlers = ReturnType<typeof cabooseHandlers>;
type ToolDef = {
  claude: string;
  copilot: string;
  description: string;
  shape: z.ZodRawShape;
  run: (h: Handlers, args: never) => string | Promise<string>;
  /** Only offered to the central chat (or only to repo chats). */
  only?: "central" | "repo";
};

const repoArg = z.string().describe("The repo (its folder name in the feature)");

/** Every Caboose tool, for both agents. */
const TOOLS: ToolDef[] = [
  {
    claude: "GetWorkspaceDiff",
    copilot: "caboose_get_workspace_diff",
    description:
      "Shows the feature's changes against each repo's base branch (committed, staged, unstaged and untracked), as the user sees them in Caboose's Changes view. Use stat for a file list first; pass repo and path to narrow it.",
    shape: {
      repo: z.string().optional().describe("Only this repo (folder name in the feature)"),
      path: z.string().optional().describe("Only this file (relative to the repo)"),
      stat: z.boolean().optional().describe("Only list changed files with line counts"),
    },
    run: (h, a: { repo?: string; path?: string; stat?: boolean }) => h.getWorkspaceDiff(a),
  },
  {
    claude: "DiffComment",
    copilot: "caboose_diff_comment",
    description:
      "Leaves review comments on lines of the feature's changes; the user sees them inline in the Changes view. Line numbers are in the new version of the file; paths are relative to the repo.",
    shape: {
      comments: z
        .array(
          z.object({
            repo: z.string().optional().describe("The repo the file is in (needed when the feature has several)"),
            file: z.string().describe("Path relative to the repo"),
            line: z.number().int().positive(),
            body: z.string(),
            lineText: z.string().optional().describe("The line's current text"),
          }),
        )
        .min(1),
    },
    run: (h, a: Parameters<Handlers["diffComment"]>[0]) => h.diffComment(a),
  },
  {
    claude: "GetDiffComments",
    copilot: "caboose_get_diff_comments",
    description: "Reads the review comments the user left on the feature's changes.",
    shape: { includeResolved: z.boolean().optional() },
    run: (h, a: { includeResolved?: boolean }) => h.getDiffComments(a),
  },
  {
    claude: "GetTerminalOutput",
    copilot: "caboose_get_terminal_output",
    description:
      "Reads the recent output of a terminal the user has open in this feature in Caboose: a repo's run script (dev server etc.) by default, or a terminal by its title. Use it to see server logs and errors.",
    shape: {
      terminal: z.string().optional().describe('"run" (default), a repo name for its run script, or a terminal title'),
      lines: z.number().int().positive().optional().describe("How many of the last lines (default 200)"),
    },
    run: (h, a: { terminal?: string; lines?: number }) => h.getTerminalOutput(a),
  },
  {
    claude: "ListPrograms",
    copilot: "caboose_list_programs",
    description:
      "Lists the programs each repo can run (run.sh / run_<name>.sh and configured run scripts), whether they run, their URLs, and port conflicts. These are the programs in the user's Run tab in Caboose.",
    shape: { repo: z.string().optional().describe("Only this repo") },
    run: (h, a: { repo?: string }) => h.listPrograms(a),
  },
  {
    claude: "StartProgram",
    copilot: "caboose_start_program",
    description:
      "Starts a repo's program in the user's Run tab (visible to them, its port managed by Caboose) and waits until its URL answers, it exits, or `wait` seconds pass; returns which, with its recent output. Use this rather than starting servers in a shell, which leaves programs holding ports. Read more output with GetTerminalOutput.",
    shape: {
      repo: z.string().optional().describe("The repo (a repo chat's own by default)"),
      program: z.string().optional().describe("Which program: its name (e.g. cda for run_cda.sh), \"run\", or a configured name; default the repo's first"),
      wait: z.number().int().min(0).max(180).optional().describe("Seconds to wait for it to answer (default 30)"),
    },
    run: (h, a: { repo?: string; program?: string; wait?: number }) => h.startProgram(a),
  },
  {
    claude: "StopProgram",
    copilot: "caboose_stop_program",
    description: "Stops a program running in the user's Run tab (Ctrl-C first, as the user's Stop button does).",
    shape: {
      repo: z.string().optional().describe("The repo (a repo chat's own by default)"),
      program: z.string().optional().describe("Which program; default the one running"),
    },
    run: (h, a: { repo?: string; program?: string }) => h.stopProgram(a),
  },
  {
    claude: "FetchLocal",
    copilot: "caboose_fetch_local",
    description:
      "Sends an HTTP request to a program running on this machine (http://localhost:… only) and returns the status and body: to check that what you built answers, e.g. a health endpoint or an API call.",
    shape: {
      url: z.string().describe("http://localhost:<port>/<path>"),
      method: z.string().optional().describe("GET (default), POST, …"),
      body: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
    },
    run: (h, a: { url: string; method?: string; body?: string; headers?: Record<string, string> }) => h.fetchLocal(a),
  },
  {
    claude: "ReportStatus",
    copilot: "caboose_report_status",
    description: `Reports where a repo's work stands, to the feature's log the user watches in Caboose: ${REPO_STATUSES.join(", ")}. A repo chat reports for its own repo; the central chat says which repo.`,
    shape: {
      status: z.enum(REPO_STATUSES as [RepoStatus, ...RepoStatus[]]),
      note: z.string().describe("One or two sentences: what changed, or the question / blocker"),
      repo: z.string().optional().describe("Which repo (only needed in the central chat)"),
    },
    run: (h, a: { status: RepoStatus; note: string; repo?: string }) => h.reportStatus(a),
  },
  {
    claude: "Log",
    copilot: "caboose_log",
    description: "Adds a note to the feature's log (log.md): decisions, contract details other repos need, progress worth keeping.",
    shape: { text: z.string() },
    run: (h, a: { text: string }) => h.log(a),
  },
  {
    claude: "GetFeatureStatus",
    copilot: "caboose_feature_status",
    description:
      "Everything about the feature at a glance: per repo the reported status, what its chat is doing, git state, PR and checks, Jira; plan progress; the recent log.",
    shape: {},
    run: (h) => h.featureStatus(),
  },
  {
    claude: "StartRepoChat",
    copilot: "caboose_start_repo_chat",
    description:
      "Breaks out a separate chat for one repo, working in that repo's worktree, and gives it a task. Use it when a repo needs a lot of focused work or follow-up; the user can watch and talk to it in Caboose. Write the task so it stands alone (the new chat has not seen this conversation). If the repo already has a chat, the task is sent there.",
    shape: {
      repo: repoArg,
      message: z.string().describe("The task, with the context and contracts it needs"),
      agent: z.enum(["claude", "copilot"]).optional().describe("Which agent runs it (default: the same as this chat)"),
    },
    run: (h, a: { repo: string; message: string; agent?: Agent }) => h.startRepoChat(a),
  },
  {
    claude: "MessageRepoChat",
    copilot: "caboose_message_repo_chat",
    description: "Sends a message to a repo's chat (queued if it is busy): answers, new information, follow-up tasks.",
    shape: { repo: repoArg, message: z.string() },
    run: (h, a: { repo: string; message: string }) => h.messageRepoChat(a),
  },
  {
    claude: "ProposeRepos",
    copilot: "caboose_propose_repos",
    description:
      "Suggests repos to add to the feature (each becomes a git worktree in the feature folder). The user sees a card with your suggestions and confirms, corrects or declines them; their answer comes back as a message. Only repos from the list in your instructions can be added.",
    shape: {
      repos: z
        .array(z.object({ name: z.string().describe("The repo's name, as listed"), reason: z.string().describe("One line: why this feature needs it") }))
        .min(1),
    },
    run: (h, a: { repos: { name: string; reason: string }[] }) => h.proposeRepos(a),
    only: "central",
  },
  {
    claude: "SetFeatureTitle",
    copilot: "caboose_set_feature_title",
    description: "Gives the feature a short title (a few words), shown next to its station name.",
    shape: { title: z.string() },
    run: (h, a: { title: string }) => h.setFeatureTitle(a),
    only: "central",
  },
  {
    claude: "GetRepoChat",
    copilot: "caboose_get_repo_chat",
    description: "What a repo's chat is doing (working, waiting for the user, idle) and its last reply.",
    shape: { repo: repoArg },
    run: (h, a: { repo: string }) => h.getRepoChat(a),
  },
];

/** The tools offered to a chat: everything, minus the ones for the other kind of chat. */
const toolsFor = (chat?: Chat) => TOOLS.filter((t) => !t.only || (t.only === "repo") === Boolean(chat?.repo));

export function cabooseMcp(ctx: ToolContext) {
  const h = cabooseHandlers(ctx.feature, ctx.comments, ctx.terminals, ctx);
  return createSdkMcpServer({
    name: "caboose",
    version: "1.0.0",
    tools: toolsFor(ctx.chat?.()).map((t) =>
      tool(t.claude, t.description, t.shape, async (args: unknown) => text(await t.run(h, args as never))),
    ),
  });
}

/** The same tools for Copilot, which runs them in this process too. */
export function cabooseCopilotTools(ctx: ToolContext): Tool[] {
  const h = cabooseHandlers(ctx.feature, ctx.comments, ctx.terminals, ctx);
  return toolsFor(ctx.chat?.()).map((t) => {
    const { $schema: _s, ...parameters } = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
    return defineTool(t.copilot, {
      description: t.description,
      parameters,
      skipPermission: true,
      handler: async (args) => t.run(h, args as never),
    });
  });
}

const name = (agent: "claude" | "copilot", claude: string) => {
  const t = TOOLS.find((x) => x.claude === claude)!;
  return agent === "claude" ? `mcp__caboose__${t.claude}` : t.copilot;
};

/** Appended to the agent's system prompt for every Caboose chat (the central chat, or a repo chat). */
export function cabooseInstructions(f: Feature, agent: "claude" | "copilot" = "claude", chat?: Chat, available: RepoEntry[] = []): string {
  const n = (claude: string) => name(agent, claude);
  const jira = readFeatureJira(f.folder);
  const repos = f.repos.map(
    (r, i) =>
      `- ${r.name}/ — git worktree on branch ${r.branch} (from ${r.baseRef}); CABOOSE_PORT=${f.port + 10 * i}${jira.subtasks[r.name] ? `; Jira subtask ${jira.subtasks[r.name]}` : ""}`,
  );
  const mine = chat?.repo ? f.repos.find((r) => r.name === chat.repo) : undefined;
  const common = [
    jira.task ? `The feature is Jira task ${jira.task} (see jira.txt in the feature folder); each repo's branch carries its own subtask key.` : "",
    `The feature's working files are plain markdown in ${f.folder}: brief.md (the goal), plan.md (a checklist the user follows; tick items as they are done), briefs/<repo>.md (each repo's part) and log.md (append-only; write to it with ${n("Log")} and ${n("ReportStatus")}, not by editing). Read them when they exist.`,
    `The user sees the changes in Caboose's Changes view. Use ${n("GetWorkspaceDiff")} to see the same diff, ${n("GetDiffComments")} to read the user's review comments, and ${n("DiffComment")} to point the user at specific lines.`,
    `Use ${n("GetTerminalOutput")} to read the user's terminals in Caboose, such as a dev server started by the Run button. Ports ${f.port}–${f.port + 99} are reserved for this feature; each repo's scripts and terminals get their own CABOOSE_PORT.`,
    `${n("GetFeatureStatus")} shows every repo's reported status, chat, git state and PR at a glance.`,
    `To check that your work runs, use ${n("ListPrograms")}, ${n("StartProgram")} (it waits until the program answers on its URL and tells you if it crashed) and ${n("FetchLocal")} to call its endpoints; ${n("StopProgram")} when done, unless the user wants it running. These run in the user's Run tab, where they can see them. Do not start servers yourself in a shell: they keep holding their ports after you are done.`,
  ];
  if (mine) {
    return [
      `You are running inside Caboose, as the agent for the ${mine.name} repo of the feature "${f.title || f.name}" (${f.name}).`,
      `You work in ${mine.path}, a git worktree on branch ${mine.branch}. The feature's other repos (below) are other chats' work: read them if you need to, but do not change them.`,
      ...repos,
      `Report as you go with ${n("ReportStatus")}: working, needs-input or blocked (and ask the user directly with your question tool), ready when committed locally, in-review once a PR exists, done when merged.`,
      `To reach another repo's chat, use ${n("MessageRepoChat")}.`,
      ...common,
    ]
      .filter(Boolean)
      .join("\n");
  }
  const addable = available.filter((r) => !f.repos.some((x) => x.name === r.name));
  return [
    "You are running inside Caboose, a desktop app where the user works on several features side by side.",
    f.repos.length
      ? `This is the central chat of the feature "${f.title || f.name}" (${f.name}). You are in its folder, ${f.folder}, which is not a git repository itself. Each repo of the feature is a git worktree in a subfolder:`
      : `This is the central chat of the feature "${f.title || f.name}" (${f.name}), in its folder ${f.folder}. The feature has no repos yet.`,
    ...repos,
    addable.length
      ? `Repos that can be added to the feature (their main checkouts; read them to find out what the work touches, but never change them):\n${addable.map((r) => `- ${r.name}: ${r.path}`).join("\n")}\nWhen the work needs repos the feature does not have, suggest them with ${n("ProposeRepos")} (one line of reason each) and let the user decide; the answer comes back as a message. Do not create worktrees or branches yourself.`
      : "",
    !f.repos.length
      ? `If the user describes what they want, work out which repos it needs and propose them, and give the feature a short title with ${n("SetFeatureTitle")}. If the request is unclear, ask first.`
      : "",
    "Run git commands inside the repo's folder. Each repo gets its own commits, branch and pull request. Stay inside this feature's folder.",
    `You can do the work here yourself, across repos. When some repos need a lot of focused work or follow-up, break out a chat for a repo with ${n("StartRepoChat")} (give it a task that stands alone), then follow it with ${n("GetRepoChat")} / ${n("GetFeatureStatus")} and steer it with ${n("MessageRepoChat")}. The user can see and talk to every chat. When you plan cross-repo work, write brief.md, plan.md and briefs/<repo>.md first.`,
    ...common,
  ]
    .filter(Boolean)
    .join("\n");
}
