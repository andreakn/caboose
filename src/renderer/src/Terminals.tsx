import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { Terminal, Workspace } from "../../shared/types.ts";

const api = window.caboose;
/** Fonts with the symbols fancy prompts use, before plain monospace. */
const TERMINAL_FONTS = `"MesloLGS NF", "Meslo LG M DZ for Powerline", "JetBrainsMono Nerd Font", "Hack Nerd Font", "FiraCode Nerd Font", "CaskaydiaCove Nerd Font"`;
const fontSetting = api.terminalFont();

/** All open terminals, kept current from the main process. */
export function useTerminals(): Terminal[] {
  const [list, setList] = useState<Terminal[]>([]);
  useEffect(() => {
    void api.terminals("").then(setList);
    return api.onTerminalsChanged(setList);
  }, []);
  return list;
}

/** The workspace's terminal drawer: tabs for the run script and shells. */
export function TerminalPanel(props: {
  ws: Workspace;
  terminals: Terminal[];
  open: boolean;
  setOpen: (open: boolean) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
}) {
  const { ws, terminals, open, activeId } = props;
  const active = terminals.find((t) => t.id === activeId) ?? terminals.at(-1);
  const [height, setHeight] = useState(() => Number(localStorage.getItem("caboose-term-height")) || 260);

  async function newShell() {
    const r = await api.openShell(ws.id);
    if (r.ok) {
      props.setActiveId(r.value.id);
      props.setOpen(true);
    } else alert(r.error);
  }

  function startResize(e: React.MouseEvent) {
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => setHeight(Math.min(window.innerHeight - 200, Math.max(120, startH + startY - ev.clientY)));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setHeight((h) => (localStorage.setItem("caboose-term-height", String(h)), h));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  if (ws.archived) return null;

  return (
    <div className={`term-panel${open ? " open" : ""}`} style={open ? { height } : undefined}>
      {open && <div className="term-resize" onMouseDown={startResize} />}
      <div className="term-bar">
        <button className="link term-toggle" onClick={() => props.setOpen(!open)} title={open ? "Hide terminals" : "Show terminals"}>
          {open ? "▾" : "▸"} Terminal
        </button>
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`term-tab${t.id === active?.id && open ? " active" : ""}`}
            onClick={() => {
              props.setActiveId(t.id);
              props.setOpen(true);
            }}
          >
            <span className={`dot ${t.exitCode === undefined ? "setup-ok" : t.exitCode === 0 ? "" : "setup-failed"}`} />
            {t.title}
            <button
              className="tab-close"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                void api.closeTerminal(t.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        <button className="tab-new" title="New terminal" onClick={newShell}>
          +
        </button>
      </div>
      {open && (
        <div className="term-body">
          {terminals.length === 0 && (
            <div className="term-empty muted">
              No terminals. <button className="link" onClick={newShell}>Open one</button>
            </div>
          )}
          {terminals.map((t) => (
            <XtermView key={t.id} id={t.id} visible={t.id === active?.id} />
          ))}
        </div>
      )}
    </div>
  );
}

function XtermView({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fit = useRef<FitAddon | null>(null);
  const term = useRef<Xterm | null>(null);

  useEffect(() => {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    const t = new Xterm({
      fontFamily: `${TERMINAL_FONTS}, ${v("--mono")}`,
      fontSize: 12.5,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: v("--card"), foreground: v("--text"), cursor: v("--accent"), selectionBackground: v("--accent-soft") },
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    void fontSetting.then((font) => {
      if (font) t.options.fontFamily = `${font}, ${v("--mono")}`;
    });
    term.current = t;
    fit.current = f;

    // Output that arrives before the saved buffer is already in it.
    let loaded = false;
    const off = api.onTermData((tid, data) => {
      if (tid === id && loaded) t.write(data);
    });
    void api.termBuffer(id).then((buf) => {
      loaded = true;
      t.write(buf);
    });
    const input = t.onData((d) => api.termWrite(id, d));
    const resized = t.onResize(({ cols, rows }) => api.termResize(id, cols, rows));

    const observer = new ResizeObserver(() => {
      if (host.current?.offsetParent) f.fit();
    });
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      off();
      input.dispose();
      resized.dispose();
      t.dispose();
    };
  }, [id]);

  useEffect(() => {
    if (!visible) return;
    requestAnimationFrame(() => {
      fit.current?.fit();
      term.current?.focus();
    });
  }, [visible]);

  return <div className="xterm-host" ref={host} hidden={!visible} />;
}
