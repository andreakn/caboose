// Per-machine UI preferences, kept in the window's localStorage.
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
