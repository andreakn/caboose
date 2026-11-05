// Review comments on a workspace's changes, by the user or by Claude.
import { randomUUID } from "node:crypto";
import type { DiffComment } from "../../shared/diff.ts";
import type { Store } from "./store.ts";

export type NewComment = Pick<DiffComment, "workspaceId" | "file" | "line" | "side" | "lineText" | "body" | "author">;

export class Comments {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  list(workspaceId: string): DiffComment[] {
    return this.store.get().comments.filter((c) => c.workspaceId === workspaceId);
  }

  add(c: NewComment): DiffComment {
    const comment: DiffComment = { ...c, id: randomUUID(), createdAt: new Date().toISOString(), resolved: false };
    this.store.update((s) => ({ ...s, comments: [...s.comments, comment] }));
    return comment;
  }

  remove(id: string): void {
    this.store.update((s) => ({ ...s, comments: s.comments.filter((c) => c.id !== id) }));
  }

  setResolved(id: string, resolved: boolean): void {
    this.patch((c) => c.id === id, { resolved });
  }

  /** The user's comments not yet sent to Claude. */
  unsent(workspaceId: string): DiffComment[] {
    return this.list(workspaceId).filter((c) => c.author === "user" && !c.sentAt && !c.resolved);
  }

  markSent(ids: string[]): void {
    const set = new Set(ids);
    this.patch((c) => set.has(c.id), { sentAt: new Date().toISOString() });
  }

  removeWorkspace(workspaceId: string): void {
    this.store.update((s) => ({ ...s, comments: s.comments.filter((c) => c.workspaceId !== workspaceId) }));
  }

  private patch(match: (c: DiffComment) => boolean, p: Partial<DiffComment>): void {
    this.store.update((s) => ({ ...s, comments: s.comments.map((c) => (match(c) ? { ...c, ...p } : c)) }));
  }
}
