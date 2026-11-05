// Caboose's own tools for the agents: for Claude an in-process MCP server
// ("caboose", seen as mcp__caboose__<Name>), for Copilot SDK tools
// (caboose_<name>). Same handlers behind both.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import type { Terminal, Workspace } from "../../shared/types.ts";
import type { Comments } from "./comments.ts";
import { changes, fullPatch } from "./diff.ts";

const MAX_CHARS = 100_000;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** What GetTerminalOutput needs from the terminal manager. */
export type TerminalSource = { list(workspaceId: string): Terminal[]; output(id: string, lines?: number): string };

/** The tool handlers, separate from the MCP wrapper so they can be tested directly. */
export function cabooseHandlers(ws: () => Workspace, comments: Comments, terminals?: TerminalSource) {
  return {
    getTerminalOutput(args: { terminal?: string; lines?: number }): string {
      const list = terminals?.list(ws().id) ?? [];
      if (!list.length) return "No terminals are open in this workspace. The user starts them in Caboose (Run, or a Terminal tab).";
      const want = args.terminal?.toLowerCase();
      const t =
        list.find((x) => x.id === args.terminal || x.title.toLowerCase() === want) ??
        (want === "run" || !want ? list.find((x) => x.kind === "run") : undefined) ??
        list.at(-1)!;
      const state = t.exitCode === undefined ? "running" : `exited with code ${t.exitCode}`;
      const names = list.map((x) => x.title).join(", ");
      return `Terminal "${t.title}" (${state}; open terminals: ${names})\n\n${terminals!.output(t.id, Math.min(args.lines ?? 200, 2000))}`;
    },

    async getWorkspaceDiff(args: { path?: string; stat?: boolean }): Promise<string> {
      const w = ws();
      if (args.stat) {
        const c = await changes(w.path, w.baseRef);
        if (!c.files.length) return `No changes against ${w.baseRef}.`;
        return c.files
          .map((f) => `${f.status.padEnd(9)} +${f.additions} -${f.deletions}  ${f.oldPath ? `${f.oldPath} -> ` : ""}${f.path}`)
          .join("\n");
      }
      const patch = await fullPatch(w.path, w.baseRef, args.path);
      if (!patch.trim()) return args.path ? `No changes to ${args.path}.` : `No changes against ${w.baseRef}.`;
      return patch.length > MAX_CHARS
        ? `${patch.slice(0, MAX_CHARS)}\n… truncated (${patch.length - MAX_CHARS} more characters). Ask for one file with \`path\`.`
        : patch;
    },

    diffComment(args: { comments: { file: string; line: number; body: string; lineText?: string }[] }): string {
      for (const c of args.comments) {
        comments.add({
          workspaceId: ws().id,
          file: c.file,
          line: c.line,
          side: "new",
          lineText: c.lineText ?? "",
          body: c.body,
          author: "claude",
        });
      }
      return `Added ${args.comments.length} comment(s) to the diff view.`;
    },

    getDiffComments(args: { includeResolved?: boolean }): string {
      const list = comments
        .list(ws().id)
        .filter((c) => c.author === "user" && (args.includeResolved || !c.resolved))
        .map(({ file, line, side, lineText, body, resolved, sentAt }) => ({ file, line, side, lineText, body, resolved, sent: Boolean(sentAt) }));
      return list.length ? JSON.stringify(list, null, 2) : "The user has left no comments.";
    },
  };
}

export function cabooseMcp(ws: () => Workspace, comments: Comments, terminals?: TerminalSource) {
  const h = cabooseHandlers(ws, comments, terminals);
  return createSdkMcpServer({
    name: "caboose",
    version: "1.0.0",
    tools: [
      tool(
        "GetWorkspaceDiff",
        "Shows this workspace's changes against its base branch (committed, staged, unstaged and untracked), as the user sees them in Caboose's Changes view. Use stat for a file list first; pass path for one file.",
        { path: z.string().optional().describe("Only this file"), stat: z.boolean().optional().describe("Only list changed files with line counts") },
        async (args) => text(await h.getWorkspaceDiff(args)),
      ),
      tool(
        "DiffComment",
        "Leaves review comments on lines of the workspace's changes; the user sees them inline in the Changes view. Line numbers are in the new version of the file.",
        {
          comments: z
            .array(
              z.object({
                file: z.string().describe("Path relative to the workspace root"),
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
        "Reads the recent output of a terminal the user has open in this workspace in Caboose: the run script (dev server etc.) by default, or a terminal by its title. Use it to see server logs and errors.",
        {
          terminal: z.string().optional().describe('"run" (default) or a terminal title such as "Terminal 2"'),
          lines: z.number().int().positive().optional().describe("How many of the last lines (default 200)"),
        },
        async (args) => text(h.getTerminalOutput(args)),
      ),
      tool(
        "GetDiffComments",
        "Reads the review comments the user left on this workspace's changes.",
        { includeResolved: z.boolean().optional() },
        async (args) => text(h.getDiffComments(args)),
      ),
    ],
  });
}

/** The same tools for Copilot, which runs them in this process too. */
export function cabooseCopilotTools(ws: () => Workspace, comments: Comments, terminals?: TerminalSource): Tool[] {
  const h = cabooseHandlers(ws, comments, terminals);
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
  return [
    defineTool(COPILOT_NAMES.diff, {
      description:
        "Shows this workspace's changes against its base branch (committed, staged, unstaged and untracked), as the user sees them in Caboose's Changes view. Use stat for a file list first; pass path for one file.",
      parameters: obj({ path: { type: "string", description: "Only this file" }, stat: { type: "boolean", description: "Only list changed files with line counts" } }),
      skipPermission: true,
      handler: (args) => h.getWorkspaceDiff(args as { path?: string; stat?: boolean }),
    }),
    defineTool(COPILOT_NAMES.comment, {
      description:
        "Leaves review comments on lines of the workspace's changes; the user sees them inline in the Changes view. Line numbers are in the new version of the file.",
      parameters: obj(
        {
          comments: {
            type: "array",
            minItems: 1,
            items: obj(
              {
                file: { type: "string", description: "Path relative to the workspace root" },
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
      description: "Reads the review comments the user left on this workspace's changes.",
      parameters: obj({ includeResolved: { type: "boolean" } }),
      skipPermission: true,
      handler: async (args) => h.getDiffComments(args as { includeResolved?: boolean }),
    }),
    defineTool(COPILOT_NAMES.terminal, {
      description:
        "Reads the recent output of a terminal the user has open in this workspace in Caboose: the run script (dev server etc.) by default, or a terminal by its title. Use it to see server logs and errors.",
      parameters: obj({
        terminal: { type: "string", description: '"run" (default) or a terminal title such as "Terminal 2"' },
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
export function cabooseInstructions(w: Workspace, agent: "claude" | "copilot" = "claude"): string {
  const n = agent === "claude" ? CLAUDE_NAMES : COPILOT_NAMES;
  return [
    "You are running inside Caboose, a desktop app where the user runs several coding-agent sessions side by side, each in its own git worktree.",
    `This workspace is "${w.name}": the worktree at ${w.path} on branch ${w.branch}, compared against ${w.baseRef}.`,
    "Stay inside this worktree. `.context/` in it is gitignored scratch space for notes and files to share with other sessions.",
    `The user can see your changes in Caboose's Changes view. Use ${n.diff} to see the same diff, ${n.comments} to read the user's review comments, and ${n.comment} to point the user at specific lines.`,
    `Use ${n.terminal} to read the user's terminals in Caboose, such as the dev server started by the Run button.`,
    w.port
      ? `Ports ${w.port}–${w.port + 9} are reserved for this workspace (CABOOSE_PORT=${w.port} in its scripts and terminals), so it can run alongside other workspaces. Prefer them when starting servers.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
