import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AppInfo, Result } from "../../shared/types.ts";

const api = window.caboose;

export type MenuItem = { label: ReactNode; onClick: () => void; title?: string } | "separator";

/** A button that opens a small menu (fixed-positioned, so scrolling containers do not clip it). */
export function MenuButton(props: { label: ReactNode; items: MenuItem[]; className?: string; title?: string; align?: "left" | "right" }) {
  const [at, setAt] = useState<{ x: number; y: number; right: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setAt(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [at]);
  return (
    <>
      <button
        className={props.className}
        title={props.title}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(at ? null : { x: r.left, y: r.bottom + 2, right: window.innerWidth - r.right });
        }}
      >
        {props.label}
      </button>
      {at && (
        <div
          ref={ref}
          className="menu"
          style={props.align === "right" ? { right: at.right, top: at.y } : { left: at.x, top: at.y }}
        >
          {props.items.map((item, i) =>
            item === "separator" ? (
              <hr key={i} />
            ) : (
              <button
                key={i}
                title={item.title}
                onClick={() => {
                  setAt(null);
                  item.onClick();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </>
  );
}

let appsCache: Promise<AppInfo[]> | null = null;
export function useApps(): AppInfo[] {
  const [apps, setApps] = useState<AppInfo[]>([]);
  useEffect(() => {
    appsCache ??= api.apps();
    void appsCache.then(setApps);
  }, []);
  return apps;
}

const report = (r: Result<void>) => {
  if (!r.ok) alert(r.error);
};

/** "Open ▾": the folder in VS Code, Rider, Visual Studio, a terminal or the file manager (what this machine has). */
export function OpenInMenu({ path, only, label = "Open ▾" }: { path: string; only?: AppInfo["id"][]; label?: ReactNode }) {
  const apps = useApps().filter((a) => !only || only.includes(a.id));
  if (!apps.length) return null;
  return (
    <MenuButton
      label={label}
      title={`Open ${path}`}
      align="right"
      items={apps.map((a) => ({ label: a.label, onClick: () => void api.openIn(a.id, path).then(report) }))}
    />
  );
}

const GLYPH: Record<AppInfo["id"], string> = { vscode: "⌨", rider: "R", visualStudio: "VS", terminal: ">_", files: "📁" };

function AppIcon({ app }: { app: AppInfo }) {
  return app.icon ? <img className="app-icon" src={app.icon} alt="" /> : <span className="app-icon glyph">{GLYPH[app.id]}</span>;
}

/**
 * Like Conductor's: the icon of the app you opened last (one click opens the
 * folder there again) and ▾ for the others. The last app is remembered.
 */
export function OpenAppButton({ path, only, what }: { path: string; only?: AppInfo["id"][]; what: string }) {
  const apps = useApps().filter((a) => !only || only.includes(a.id));
  const [last, setLast] = useState(() => localStorage.getItem("caboose-open-app"));
  if (!apps.length) return null;
  const current = apps.find((a) => a.id === last) ?? apps.find((a) => a.id === "vscode") ?? apps[0];
  const open = (a: AppInfo) => {
    localStorage.setItem("caboose-open-app", a.id);
    setLast(a.id);
    void api.openIn(a.id, path).then(report);
  };
  return (
    <span className="open-app">
      <button className="open-app-main" title={`Open ${what} in ${current.label}`} onClick={() => open(current)}>
        <AppIcon app={current} />
      </button>
      <MenuButton
        className="open-app-more"
        label="▾"
        title={`Open ${what} in…`}
        align="right"
        items={apps.map((a) => ({
          label: (
            <span className="open-app-item">
              <AppIcon app={a} />
              {a.label}
            </span>
          ),
          onClick: () => open(a),
        }))}
      />
    </span>
  );
}
