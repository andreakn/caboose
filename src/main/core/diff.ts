// What a workspace has changed compared with its base: committed, staged,
// unstaged and untracked, like a PR would show once everything is committed.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FileChange, FileStatus, WorkspaceChanges } from "../../shared/diff.ts";
import { git } from "./run.ts";

const MAX_TEXT_BYTES = 1024 * 1024;

export async function mergeBase(wsPath: string, baseRef: string): Promise<string> {
  try {
    return await git(wsPath, "merge-base", "HEAD", baseRef);
  } catch {
    return baseRef;
  }
}

export async function changes(wsPath: string, baseRef: string): Promise<WorkspaceChanges> {
  const base = await mergeBase(wsPath, baseRef);
  const [nameStatus, numstat, untracked] = await Promise.all([
    git(wsPath, "diff", "--name-status", "-z", "-M", base),
    git(wsPath, "diff", "--numstat", "-z", "-M", base),
    git(wsPath, "ls-files", "--others", "--exclude-standard", "-z"),
  ]);

  const counts = parseNumstat(numstat);
  const files: FileChange[] = [];
  const t = nameStatus.split("\0");
  for (let i = 0; i < t.length - 1; ) {
    const code = t[i++];
    if (!code) continue;
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = t[i++];
      const path = t[i++];
      const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
      files.push({ path, oldPath, status: "renamed", ...c });
    } else {
      const path = t[i++];
      const c = counts.get(path) ?? { additions: 0, deletions: 0, binary: false };
      files.push({ path, status: STATUS[code[0]] ?? "modified", ...c });
    }
  }
  for (const path of untracked.split("\0").filter(Boolean)) {
    const text = await readText(join(wsPath, path));
    files.push({
      path,
      status: "untracked",
      additions: text === null ? 0 : lineCount(text),
      deletions: 0,
      binary: text === null,
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { base, baseRef, files };
}

/** A unified diff for one file (empty for binary files). */
export async function filePatch(wsPath: string, base: string, file: FileChange): Promise<string> {
  if (file.binary) return "";
  if (file.status === "untracked") {
    const text = (await readText(join(wsPath, file.path))) ?? "";
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return [
      `diff --git a/${file.path} b/${file.path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file.path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
      "",
    ].join("\n");
  }
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  return git(wsPath, "diff", "-M", base, "--", ...paths);
}

/** Every change as one patch, for Claude. */
export async function fullPatch(wsPath: string, baseRef: string, only?: string): Promise<string> {
  const c = await changes(wsPath, baseRef);
  const files = only ? c.files.filter((f) => f.path === only || f.oldPath === only) : c.files;
  const parts = await Promise.all(
    files.map(async (f) => (f.binary ? `Binary file ${f.path} (${f.status})` : await filePatch(wsPath, c.base, f))),
  );
  return parts.join("\n");
}

const STATUS: Record<string, FileStatus> = { A: "added", M: "modified", D: "deleted", T: "modified" };

function parseNumstat(out: string): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const m = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const t = out.split("\0");
  for (let i = 0; i < t.length; i++) {
    const parts = t[i].split("\t");
    if (parts.length < 3) continue;
    const [a, d, p] = parts;
    // Renames: "a\td\t" followed by old and new path as separate fields.
    const path = p === "" ? (i += 2, t[i]) : p;
    m.set(path, { additions: a === "-" ? 0 : Number(a), deletions: d === "-" ? 0 : Number(d), binary: a === "-" });
  }
  return m;
}

/** The file's text, or null when it is binary or too big to show. */
async function readText(file: string): Promise<string | null> {
  try {
    if ((await stat(file)).size > MAX_TEXT_BYTES) return null;
    const buf = await readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
