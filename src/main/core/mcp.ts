// Caboose's own tools for Claude, as an in-process MCP server ("caboose").
// Claude sees them as mcp__caboose__<Name>.
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Workspace } from "../../shared/types.ts";
import type { Comments } from "./comments.ts";
import { changes, fullPatch } from "./diff.ts";

const MAX_CHARS = 100_000;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/** The tool handlers, separate from the MCP wrapper so they can be tested directly. */
export function cabooseHandlers(ws: () => Workspace, comments: Comments) {
  return {
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

export function cabooseMcp(ws: () => Workspace, comments: Comments) {
  const h = cabooseHandlers(ws, comments);
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
        "GetDiffComments",
        "Reads the review comments the user left on this workspace's changes.",
        { includeResolved: z.boolean().optional() },
        async (args) => text(h.getDiffComments(args)),
      ),
    ],
  });
}

/** Appended to Claude Code's system prompt for every Caboose chat. */
export function cabooseInstructions(w: Workspace): string {
  return [
    "You are running inside Caboose, a desktop app where the user runs several Claude Code sessions side by side, each in its own git worktree.",
    `This workspace is "${w.name}": the worktree at ${w.path} on branch ${w.branch}, compared against ${w.baseRef}.`,
    "Stay inside this worktree. `.context/` in it is gitignored scratch space for notes and files to share with other sessions.",
    "The user can see your changes in Caboose's Changes view. Use mcp__caboose__GetWorkspaceDiff to see the same diff, mcp__caboose__GetDiffComments to read the user's review comments, and mcp__caboose__DiffComment to point the user at specific lines.",
  ].join("\n");
}
