// Features that were archived (Archive… → Archive): their folders in the
// archive roots hold everything Caboose knew (feature.json), each chat as
// markdown and as replayable events (chats/NN-name.jsonl), and the feature's
// files (brief, plan, briefs/, log). Read from disk, not from the state, so
// archives made before this existed show up too, and moving or deleting an
// archive folder is all it takes to make one go away.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Chat, LastingEvent } from "../../shared/chat.ts";
import type { ArchivedFeature, Feature } from "../../shared/types.ts";

type Record = { feature: Feature; archivedAt: string; chats?: Chat[]; closedPrs?: number[]; deletedBranches?: string[] };

const pad = (n: number) => String(n).padStart(2, "0");

/** The archived features in these folders (each a <stamp>_<station> folder with a feature.json), newest first. */
export function listArchived(roots: string[]): ArchivedFeature[] {
  const out: ArchivedFeature[] = [];
  for (const root of [...new Set(roots)]) {
    let names: string[] = [];
    try {
      names = existsSync(root) ? readdirSync(root) : [];
    } catch {
      continue;
    }
    for (const name of names) {
      const folder = join(root, name);
      const a = readArchived(folder);
      if (a) out.push(a);
    }
  }
  return out.sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
}

/** One archive folder, or null when it is not one. */
export function readArchived(folder: string): ArchivedFeature | null {
  let record: Record;
  try {
    if (!statSync(folder).isDirectory()) return null;
    record = JSON.parse(readFileSync(join(folder, "feature.json"), "utf8")) as Record;
  } catch {
    return null;
  }
  const f = record.feature;
  if (!f?.id || !f.name) return null;
  const files = existsSync(join(folder, "chats")) ? readdirSync(join(folder, "chats")) : [];
  const chats = (record.chats ?? []).flatMap((c, i) => {
    // Written in this order as NN-<name>.jsonl (see retire.ts).
    const file = files.find((x) => x.startsWith(`${pad(i + 1)}-`) && x.endsWith(".jsonl"));
    return file ? [{ chat: c, file: join("chats", file) }] : [];
  });
  return {
    id: f.id,
    name: f.name,
    ...(f.title ? { title: f.title } : {}),
    ...(f.line ? { line: f.line } : {}),
    folder,
    archivedAt: record.archivedAt,
    createdAt: f.createdAt,
    repos: f.repos.map((r) => ({ name: r.name, branch: r.branch, baseRef: r.baseRef })),
    chats: chats.map(({ chat, file }) => ({
      id: chat.id,
      title: chat.title,
      ...(chat.repo ? { repo: chat.repo } : {}),
      agent: chat.agent ?? "claude",
      file,
      messages: messagesIn(join(folder, file)),
    })),
    closedPrs: record.closedPrs ?? [],
  };
}

/** How many messages (the user's and the agent's) a saved transcript has. */
function messagesIn(path: string): number {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => {
        try {
          const t = (JSON.parse(l) as { t?: string }).t;
          return t === "user" || t === "text";
        } catch {
          return false;
        }
      }).length;
  } catch {
    return 0;
  }
}

/** An archived chat's events, to show or to carry into a continued feature. */
export function archivedChatEvents(a: ArchivedFeature, chatId: string): LastingEvent[] {
  const c = a.chats.find((x) => x.id === chatId);
  if (!c) return [];
  try {
    return readFileSync(join(a.folder, c.file), "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as LastingEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** The feature's own files as they were archived: brief, plan, log and per-repo briefs (missing ones left out). */
export function archivedDocs(a: ArchivedFeature): { name: string; text: string }[] {
  const read = (rel: string) => {
    try {
      return readFileSync(join(a.folder, rel), "utf8");
    } catch {
      return undefined;
    }
  };
  const briefs = existsSync(join(a.folder, "briefs")) ? readdirSync(join(a.folder, "briefs")).filter((n) => n.endsWith(".md")).sort() : [];
  return ["brief.md", "plan.md", ...briefs.map((b) => `briefs/${b}`), "log.md"].flatMap((name) => {
    const text = read(name);
    return text?.trim() ? [{ name, text }] : [];
  });
}
