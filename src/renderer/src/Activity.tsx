import { useEffect, useMemo, useState } from "react";
import { type Chat, type ChatEvent, eventTime } from "../../shared/chat.ts";
import type { Feature } from "../../shared/types.ts";
import { toolName, toolSummary } from "./Chat.tsx";
import { repoLabel } from "./labels.ts";

const api = window.caboose;

type Line = { at: string; chatId: string; icon: string; text: string; tone?: "error" | "ask" | "you" };

/** One line per thing that happened in a chat; null for events not worth a line. */
function lineFor(chatId: string, e: ChatEvent, rel: (p: string) => string): Line | null {
  const at = eventTime(e);
  if (!at) return null;
  const first = (s: string) => s.split("\n").find((l) => l.trim()) ?? "";
  switch (e.t) {
    case "user":
      return { at, chatId, icon: "›", text: first(e.text), tone: "you" };
    case "text":
      return { at, chatId, icon: "💬", text: first(e.text) };
    case "tool":
      return { at, chatId, icon: "⚙", text: `${toolName(e.name)} ${toolSummary(e.input, rel)}` };
    case "tool_result":
      return e.isError ? { at, chatId, icon: "✗", text: first(e.content) || "tool failed", tone: "error" } : null;
    case "permission":
      return { at, chatId, icon: "?", text: `asks to use ${toolName(e.tool)}`, tone: "ask" };
    case "question":
      return { at, chatId, icon: "?", text: e.questions.map((q) => q.question).join(" / "), tone: "ask" };
    case "result":
      return e.ok ? null : { at, chatId, icon: "■", text: `stopped: ${e.error ?? "error"}`, tone: "error" };
    case "error":
      return { at, chatId, icon: "✗", text: e.text, tone: "error" };
    default:
      return null;
  }
}

/** Every chat of the feature in one feed, newest first; click a line to open that chat. */
export function ActivityView({ f, chats, onOpenChat }: { f: Feature; chats: Chat[]; onOpenChat: (id: string) => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [only, setOnly] = useState<string>("all");
  const rel = (p: string) => (p.startsWith(f.folder) ? p.slice(f.folder.length + 1) || "." : p);
  const ids = chats.map((c) => c.id).join();

  useEffect(() => {
    let alive = true;
    void Promise.all(chats.map(async (c) => (await api.chatEvents(c.id)).map((e) => lineFor(c.id, e, rel)))).then((all) => {
      if (alive) setLines(all.flat().filter((l): l is Line => Boolean(l)));
    });
    const off = api.onChatEvent((chatId, e) => {
      if (!chats.some((c) => c.id === chatId)) return;
      const l = lineFor(chatId, e, rel);
      if (l) setLines((x) => [...x, l]);
    });
    return () => {
      alive = false;
      off();
    };
  }, [ids]);

  const label = (id: string) => {
    const c = chats.find((x) => x.id === id);
    return c?.repo ?? (chats.filter((x) => !x.repo).length > 1 ? (c?.title ?? "chat") : "central");
  };
  const shown = useMemo(
    () => lines.filter((l) => only === "all" || l.chatId === only).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300),
    [lines, only],
  );

  return (
    <div className="plan-view">
      <div className="row">
        <select value={only} onChange={(e) => setOnly(e.target.value)} className="activity-filter">
          <option value="all">every chat</option>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.repo ? `⑂ ${repoLabel(c.repo)}` : c.title}
            </option>
          ))}
        </select>
        <span className="muted">{shown.length} event(s), newest first</span>
      </div>
      <div className="plan-section activity">
        {shown.length === 0 && <div className="muted">Nothing yet.</div>}
        {shown.map((l, i) => (
          <div key={i} className={`act-line${l.tone ? ` t-${l.tone}` : ""}`} onClick={() => onOpenChat(l.chatId)} title="Open this chat">
            <span className="muted log-time">{new Date(l.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className={`who c${hash(label(l.chatId)) % 6}`}>{label(l.chatId)}</span>
            <span className="act-icon">{l.icon}</span>
            <span className="one-line">{l.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
