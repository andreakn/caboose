// What every chat is doing, across all workspaces: working, waiting for the
// user (a permission or a question), or finished while the user looked away.
import { useSyncExternalStore } from "react";
import { noticeBody } from "../../shared/chat.ts";

export type Activity = { running: boolean; waiting: number; unread: boolean };
/** `body`: what it is about (the question, what approval is for, the answer's start). */
type Notice = { chatId: string; kind: "done" | "needs"; what: "question" | "approval" | "done" | "stopped"; body: string };

const chats = new Map<string, { running: boolean; waiting: Set<string>; unread: boolean; lastText?: string }>();
const listeners = new Set<() => void>();
let version = 0;
let visibleChat: string | null = null;
let onNotice: (n: Notice) => void = () => {};

const get = (id: string) => {
  let c = chats.get(id);
  if (!c) chats.set(id, (c = { running: false, waiting: new Set(), unread: false }));
  return c;
};
const changed = () => {
  version++;
  for (const l of listeners) l();
};
const seen = (id: string) => id === visibleChat && document.hasFocus();

window.caboose.onChatEvent((chatId, e) => {
  const c = get(chatId);
  switch (e.t) {
    case "status":
      c.running = e.running;
      break;
    case "text":
      c.lastText = e.text;
      return;
    case "permission":
    case "question":
      c.waiting.add(e.id);
      if (!seen(chatId)) onNotice({ chatId, kind: "needs", what: e.t === "question" ? "question" : "approval", body: noticeBody(e) });
      break;
    case "permission_answer":
    case "question_answer":
      c.waiting.delete(e.id);
      break;
    case "result":
      if (!seen(chatId)) {
        c.unread = true;
        onNotice({ chatId, kind: "done", what: e.ok ? "done" : "stopped", body: noticeBody(e, c.lastText) });
      }
      break;
    default:
      return;
  }
  changed();
});

window.addEventListener("focus", () => {
  if (visibleChat && chats.get(visibleChat)?.unread) {
    get(visibleChat).unread = false;
    changed();
  }
});

/** The chat the user is looking at (null when none). Marks it read. */
export function setVisibleChat(id: string | null): void {
  visibleChat = id;
  if (id && chats.get(id)?.unread) {
    get(id).unread = false;
    changed();
  }
}

export function onActivityNotice(fn: (n: Notice) => void): void {
  onNotice = fn;
}

export function activityOf(chatIds: string[]): Activity {
  let running = false;
  let waiting = 0;
  let unread = false;
  for (const id of chatIds) {
    const c = chats.get(id);
    if (!c) continue;
    running ||= c.running;
    waiting += c.waiting.size;
    unread ||= c.unread;
  }
  return { running, waiting, unread };
}

/** Re-renders the caller whenever any chat's activity changes. */
export function useActivityVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** What a chat wants from the user: "needs" (waiting for an answer), "done" (finished unseen), or nothing. */
export function attentionOf(chatId: string): "needs" | "done" | undefined {
  const c = chats.get(chatId);
  if (!c) return undefined;
  if (c.waiting.size > 0) return "needs";
  if (c.unread) return "done";
  return undefined;
}
