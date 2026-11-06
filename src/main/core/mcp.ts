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
import { type Feature, type FeatureRepo, REPO_STATUSES, type RepoStatus, type Terminal } from "../../shared/types.ts";
import type { Comments } from "./comments.ts";
import type { Coordinator } from "./coordination.ts";
import { changes, fullPatch } from "./diff.ts";
import { readFeatureJira } from "./jira.ts";

const MAX_CHARS = 100_000;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** What GetTerminalOutput needs from the terminal manager. */
export type TerminalSource = { list(featureId: string): Terminal[]; output(id: string, lines?: number): string };

/** What the tools work on: the feature, the chat that calls them, and the app's services. */
export type ToolContext = {
  feature: () => Feature;
  chat?: () => Chat | undefined;
  comments: Comments;
  terminals?: TerminalSource;
  coord?: Coordinator;
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

  return {
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
export function cabooseInstructions(f: Feature, agent: "claude" | "copilot" = "claude", chat?: Chat): string {
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
  return [
    "You are running inside Caboose, a desktop app where the user works on several features side by side.",
    `This is the central chat of the feature "${f.title || f.name}" (${f.name}). You are in its folder, ${f.folder}, which is not a git repository itself. Each repo of the feature is a git worktree in a subfolder:`,
    ...repos,
    "Run git commands inside the repo's folder. Each repo gets its own commits, branch and pull request. Stay inside this feature's folder.",
    `You can do the work here yourself, across repos. When some repos need a lot of focused work or follow-up, break out a chat for a repo with ${n("StartRepoChat")} (give it a task that stands alone), then follow it with ${n("GetRepoChat")} / ${n("GetFeatureStatus")} and steer it with ${n("MessageRepoChat")}. The user can see and talk to every chat. When you plan cross-repo work, write brief.md, plan.md and briefs/<repo>.md first.`,
    ...common,
  ]
    .filter(Boolean)
    .join("\n");
}
