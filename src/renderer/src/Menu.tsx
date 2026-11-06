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
