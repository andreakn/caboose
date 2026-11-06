// Caboose's own tools for the agents: for Claude an in-process MCP server
// ("caboose", seen as mcp__caboose__<Name>), for Copilot SDK tools
// (caboose_<name>). Same handlers behind both. They cover every repo in the
// feature; `repo` narrows them to one.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import type { Feature, FeatureRepo, Terminal } from "../../shared/types.ts";
import type { Comments } from "./comments.ts";
import { changes, fullPatch } from "./diff.ts";
import { readFeatureJira } from "./jira.ts";

const MAX_CHARS = 100_000;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** What GetTerminalOutput needs from the terminal manager. */
export type TerminalSource = { list(featureId: string): Terminal[]; output(id: string, lines?: number): string };

/** The tool handlers, separate from the MCP wrapper so they can be tested directly. */
export function cabooseHandlers(feature: () => Feature, comments: Comments, terminals?: TerminalSource) {
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
  };
}

const D = {
  diff: "Shows the feature's changes against each repo's base branch (committed, staged, unstaged and untracked), as the user sees them in Caboose's Changes view. Use stat for a file list first; pass repo and path to narrow it.",
  comment: "Leaves review comments on lines of the feature's changes; the user sees them inline in the Changes view. Line numbers are in the new version of the file; paths are relative to the repo.",
  comments: "Reads the review comments the user left on the feature's changes.",
  terminal: "Reads the recent output of a terminal the user has open in this feature in Caboose: a repo's run script (dev server etc.) by default, or a terminal by its title. Use it to see server logs and errors.",
};

export function cabooseMcp(feature: () => Feature, comments: Comments, terminals?: TerminalSource) {
  const h = cabooseHandlers(feature, comments, terminals);
  return createSdkMcpServer({
    name: "caboose",
    version: "1.0.0",
    tools: [
      tool(
        "GetWorkspaceDiff",
        D.diff,
        {
          repo: z.string().optional().describe("Only this repo (folder name in the feature)"),
          path: z.string().optional().describe("Only this file (relative to the repo)"),
          stat: z.boolean().optional().describe("Only list changed files with line counts"),
        },
        async (args) => text(await h.getWorkspaceDiff(args)),
      ),
      tool(
        "DiffComment",
        D.comment,
        {
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
        async (args) => text(h.diffComment(args)),
      ),
      tool(
        "GetTerminalOutput",
        D.terminal,
        {
          terminal: z.string().optional().describe('"run" (default), a repo name for its run script, or a terminal title'),
          lines: z.number().int().positive().optional().describe("How many of the last lines (default 200)"),
        },
        async (args) => text(h.getTerminalOutput(args)),
      ),
      tool("GetDiffComments", D.comments, { includeResolved: z.boolean().optional() }, async (args) => text(h.getDiffComments(args))),
    ],
  });
}

/** The same tools for Copilot, which runs them in this process too. */
export function cabooseCopilotTools(feature: () => Feature, comments: Comments, terminals?: TerminalSource): Tool[] {
  const h = cabooseHandlers(feature, comments, terminals);
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
  return [
    defineTool(COPILOT_NAMES.diff, {
      description: D.diff,
      parameters: obj({
        repo: { type: "string", description: "Only this repo (folder name in the feature)" },
        path: { type: "string", description: "Only this file (relative to the repo)" },
        stat: { type: "boolean", description: "Only list changed files with line counts" },
      }),
      skipPermission: true,
      handler: (args) => h.getWorkspaceDiff(args as { repo?: string; path?: string; stat?: boolean }),
    }),
    defineTool(COPILOT_NAMES.comment, {
      description: D.comment,
      parameters: obj(
        {
          comments: {
            type: "array",
            minItems: 1,
            items: obj(
              {
                repo: { type: "string", description: "The repo the file is in (needed when the feature has several)" },
                file: { type: "string", description: "Path relative to the repo" },
                line: { type: "integer", minimum: 1 },
                body: { type: "string" },
                lineText: { type: "string", description: "The line's current text" },
              },
              ["file", "line", "body"],
            ),
          },
        },
        ["comments"],
      ),
      skipPermission: true,
      handler: async (args) => h.diffComment(args as Parameters<typeof h.diffComment>[0]),
    }),
    defineTool(COPILOT_NAMES.comments, {
      description: D.comments,
      parameters: obj({ includeResolved: { type: "boolean" } }),
      skipPermission: true,
      handler: async (args) => h.getDiffComments(args as { includeResolved?: boolean }),
    }),
    defineTool(COPILOT_NAMES.terminal, {
      description: D.terminal,
      parameters: obj({
        terminal: { type: "string", description: '"run" (default), a repo name for its run script, or a terminal title' },
        lines: { type: "integer", minimum: 1, description: "How many of the last lines (default 200)" },
      }),
      skipPermission: true,
      handler: async (args) => h.getTerminalOutput(args as { terminal?: string; lines?: number }),
    }),
  ];
}

const CLAUDE_NAMES = {
  diff: "mcp__caboose__GetWorkspaceDiff",
  comment: "mcp__caboose__DiffComment",
  comments: "mcp__caboose__GetDiffComments",
  terminal: "mcp__caboose__GetTerminalOutput",
};
const COPILOT_NAMES = {
  diff: "caboose_get_workspace_diff",
  comment: "caboose_diff_comment",
  comments: "caboose_get_diff_comments",
  terminal: "caboose_get_terminal_output",
};

/** Appended to the agent's system prompt for every Caboose chat. */
export function cabooseInstructions(f: Feature, agent: "claude" | "copilot" = "claude"): string {
  const n = agent === "claude" ? CLAUDE_NAMES : COPILOT_NAMES;
  const jira = readFeatureJira(f.folder);
  const repos = f.repos.map(
    (r, i) =>
      `- ${r.name}/ — git worktree on branch ${r.branch} (from ${r.baseRef}); CABOOSE_PORT=${f.port + 10 * i}${jira.subtasks[r.name] ? `; Jira subtask ${jira.subtasks[r.name]}` : ""}`,
  );
  return [
    "You are running inside Caboose, a desktop app where the user works on several features side by side.",
    `This feature is "${f.name}". You are in its folder, ${f.folder}, which is not a git repository itself. Each repo of the feature is a git worktree in a subfolder:`,
    ...repos,
    "Run git commands inside the repo's folder. Each repo gets its own commits, branch and pull request. Stay inside this feature's folder.",
    jira.task ? `The feature is Jira task ${jira.task} (see jira.txt in the feature folder).` : "",
    "`.context/` in the feature folder is scratch space for notes and files to keep with the feature.",
    `The user sees the changes in Caboose's Changes view. Use ${n.diff} to see the same diff, ${n.comments} to read the user's review comments, and ${n.comment} to point the user at specific lines.`,
    `Use ${n.terminal} to read the user's terminals in Caboose, such as a dev server started by the Run button.`,
    `Ports ${f.port}–${f.port + 99} are reserved for this feature; each repo's scripts and terminals get their own CABOOSE_PORT (above). Prefer them when starting servers.`,
  ]
    .filter(Boolean)
    .join("\n");
}
