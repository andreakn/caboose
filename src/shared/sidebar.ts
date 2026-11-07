// The sidebar's folder tree: pure functions over the saved layout, shared by
// the window and the tests.
import type { Feature, Sidebar } from "./types.ts";

export const ROOT = "root";
export type Key = string; // "f:<feature id>" | "d:<folder id>"
export type Drop = { key: Key; where: "before" | "after" | "inside" } | { key: typeof ROOT; where: "end" };

/**
 * The sidebar as saved, made to fit the features there are now: features
 * that ended are dropped, new ones are added at the end of the top level.
 */
export function normalize(sb: Sidebar, features: Feature[]): Sidebar {
  const live = new Set(features.map((f) => `f:${f.id}`));
  const folders = new Set(sb.folders.map((d) => `d:${d.id}`));
  const placed = new Set<Key>();
  const children: Record<string, Key[]> = {};
  for (const parent of [ROOT, ...sb.folders.map((d) => d.id)]) {
    children[parent] = (sb.children[parent] ?? []).filter((k) => (live.has(k) || folders.has(k)) && !placed.has(k) && placed.add(k));
  }
  // Folders and features nobody holds go to the top level.
  for (const k of [...folders, ...features.map((f) => `f:${f.id}`)]) if (!placed.has(k)) children[ROOT].push(k);
  return { folders: sb.folders, children, collapsed: sb.collapsed.filter((id) => folders.has(`d:${id}`)) };
}

/** Every feature in the order the tree shows them (for next/previous feature). */
export function featureOrder(sb: Sidebar): string[] {
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const k of sb.children[parent] ?? []) k.startsWith("f:") ? out.push(k.slice(2)) : walk(k.slice(2));
  };
  walk(ROOT);
  return out;
}

export const parentOf = (sb: Sidebar, key: Key) => Object.keys(sb.children).find((p) => sb.children[p].includes(key));

/** Whether folder `id` is `ancestor` or inside it. */
function within(sb: Sidebar, id: string, ancestor: string): boolean {
  for (let p: string | undefined = id; p && p !== ROOT; p = parentOf(sb, `d:${p}`)) if (p === ancestor) return true;
  return false;
}

/** `key` moved to where it was dropped; unchanged if that would put a folder inside itself. */
export function move(sb: Sidebar, key: Key, drop: Drop): Sidebar {
  if (drop.key === key) return sb;
  const target = drop.where === "end" ? ROOT : drop.where === "inside" ? drop.key.slice(2) : (parentOf(sb, drop.key) ?? ROOT);
  if (key.startsWith("d:") && target !== ROOT && within(sb, target, key.slice(2))) return sb;
  const children = Object.fromEntries(Object.entries(sb.children).map(([p, ks]) => [p, ks.filter((k) => k !== key)]));
  const list = (children[target] ??= []);
  if (drop.where === "before" || drop.where === "after") {
    const i = list.indexOf(drop.key);
    list.splice(drop.where === "before" ? i : i + 1, 0, key);
  } else list.push(key);
  // Dropping into a closed folder opens it, so you see where it went.
  const collapsed = drop.where === "inside" ? sb.collapsed.filter((id) => id !== target) : sb.collapsed;
  return { ...sb, children, collapsed };
}

