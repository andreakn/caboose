// Workspace changes and unified-diff parsing, shared by main and renderer.

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export type FileChange = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
};

export type WorkspaceChanges = {
  /** The commit the workspace is compared with: merge-base of HEAD and the base ref. */
  base: string;
  baseRef: string;
  files: FileChange[];
};

export type DiffLine = { type: "add" | "del" | "ctx"; old?: number; new?: number; text: string };
export type Hunk = { header: string; lines: DiffLine[] };

export type DiffComment = {
  id: string;
  featureId: string;
  /** The repo (folder name in the feature) the file is in. */
  repo: string;
  /** Path relative to the repo. */
  file: string;
  /** Line number on `side`: new-file numbers for added/context lines, old-file numbers for deleted ones. */
  line: number;
  side: "new" | "old";
  /** The line's text when the comment was made, so it still reads right after the code moves. */
  lineText: string;
  body: string;
  author: "user" | "claude";
  createdAt: string;
  /** When a user comment was sent to Claude. */
  sentAt?: string;
  resolved: boolean;
};

/** Parses the hunks of a single-file unified diff. */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let hunk: Hunk | undefined;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of patch.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) {
      oldNo = Number(h[1]);
      newNo = Number(h[2]);
      hunk = { header: line, lines: [] };
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue; // file headers
    if (line.startsWith("+")) hunk.lines.push({ type: "add", new: newNo++, text: line.slice(1) });
    else if (line.startsWith("-")) hunk.lines.push({ type: "del", old: oldNo++, text: line.slice(1) });
    else if (line.startsWith(" ")) hunk.lines.push({ type: "ctx", old: oldNo++, new: newNo++, text: line.slice(1) });
    // "\ No newline at end of file" and the trailing empty line are skipped
  }
  return hunks;
}

/** The message that hands the user's review comments to Claude. */
export function commentsMessage(comments: DiffComment[]): string {
  const parts = comments.map((c) => {
    const where = `${c.repo}/${c.file}:${c.line}${c.side === "old" ? " (removed line)" : ""}`;
    return `**${where}**\n\`\`\`\n${c.lineText}\n\`\`\`\n${c.body}`;
  });
  return `I left ${comments.length === 1 ? "a review comment" : `${comments.length} review comments`} on the changes. Please address ${comments.length === 1 ? "it" : "them"}:\n\n${parts.join("\n\n")}`;
}
