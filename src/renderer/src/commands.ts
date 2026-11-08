// Menu commands and in-app requests, as window events, so any component can
// react without threading callbacks through the tree.
import { useEffect, useRef } from "react";
import type { MenuCommand } from "../../shared/types.ts";

export type Command = MenuCommand | `selectChat:${string}` | `breakOut:${string}` | `openFeature:${string}`;

export function dispatch(command: Command): void {
  window.dispatchEvent(new CustomEvent<Command>("caboose-command", { detail: command }));
}

/** Calls `handler` for every command; it always sees the latest props. */
export function useCommand(handler: (command: Command) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const listener = (e: Event) => ref.current((e as CustomEvent<Command>).detail);
    window.addEventListener("caboose-command", listener);
    return () => window.removeEventListener("caboose-command", listener);
  }, []);
}

window.caboose.onMenuCommand(dispatch);
