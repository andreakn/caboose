// Per-machine UI preferences, kept in the window's localStorage.
import { useEffect, useState } from "react";
import { type ChatShow, SHOW_ALL } from "../../shared/chat.ts";
import type { Theme } from "../../shared/types.ts";

export function getTheme(): Theme {
  return (localStorage.getItem("caboose-theme") as Theme) || "system";
}

export function applyTheme(theme: Theme): void {
  localStorage.setItem("caboose-theme", theme);
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  window.caboose.setTheme(theme);
}

export function notificationsOn(): boolean {
  return localStorage.getItem("caboose-notifications") !== "off";
}

export function setNotifications(on: boolean): void {
  localStorage.setItem("caboose-notifications", on ? "on" : "off");
}

/** What chats show besides the conversation (progress notes, thinking, tool calls); one choice for every chat. */
export function getChatShow(): ChatShow {
  try {
    return { ...SHOW_ALL, ...(JSON.parse(localStorage.getItem("caboose-chat-show") ?? "{}") as Partial<ChatShow>) };
  } catch {
    return SHOW_ALL;
  }
}

export function setChatShow(show: ChatShow): void {
  localStorage.setItem("caboose-chat-show", JSON.stringify(show));
  window.dispatchEvent(new Event("caboose-chat-show"));
}

/** The choice, kept in step across every open chat. */
export function useChatShow(): ChatShow {
  const [show, setShow] = useState(getChatShow);
  useEffect(() => {
    const on = () => setShow(getChatShow());
    window.addEventListener("caboose-chat-show", on);
    return () => window.removeEventListener("caboose-chat-show", on);
  }, []);
  return show;
}
