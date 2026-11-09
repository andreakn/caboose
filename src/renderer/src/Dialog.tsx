import { useEffect, useRef, useState } from "react";

// Electron has no window.prompt(), so Caboose asks for text with its own dialog.

type Ask = {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  multiline?: boolean;
  ok?: string;
  resolve: (v: string | null) => void;
};

let show: ((a: Ask) => void) | null = null;

/** A question with buttons (and maybe a line of text to fill in): which button, and the text. */
type Choice = {
  title: string;
  body: string;
  input?: { label: string; value: string; placeholder?: string };
  buttons: { id: string; label: string; primary?: boolean }[];
  resolve: (v: { id: string; value: string } | null) => void;
};
let showChoice: ((c: Choice) => void) | null = null;

/** Asks the user to pick one of the buttons; null when dismissed. */
export function askChoice(opts: Omit<Choice, "resolve">): Promise<{ id: string; value: string } | null> {
  return new Promise((resolve) => {
    if (!showChoice) return resolve(null);
    showChoice({ ...opts, resolve });
  });
}

function ChoiceHost() {
  const [c, setC] = useState<Choice | null>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    showChoice = (x) => {
      setC(x);
      setValue(x.input?.value ?? "");
    };
    return () => {
      showChoice = null;
    };
  }, []);
  if (!c) return null;
  const done = (v: { id: string; value: string } | null) => {
    c.resolve(v);
    setC(null);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className="dialog" role="dialog">
        <h2>{c.title}</h2>
        <p className="choice-body">{c.body}</p>
        {c.input && (
          <label className="choice-input">
            <span className="muted small">{c.input.label}</span>
            <input autoFocus value={value} placeholder={c.input.placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Escape" && done(null)} />
          </label>
        )}
        <div className="row">
          <span className="spacer" />
          {c.buttons.map((b) => (
            <button key={b.id} className={b.primary ? "primary" : ""} disabled={b.primary && !!c.input && !value.trim()} onClick={() => done({ id: b.id, value })}>
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Asks for a line (or block) of text; null when cancelled. */
export function askText(opts: Omit<Ask, "resolve">): Promise<string | null> {
  return new Promise((resolve) => {
    if (!show) return resolve(null);
    show({ ...opts, resolve });
  });
}

/** Mounted once, in App. */
export function DialogHost() {
  return (
    <>
      <TextHost />
      <ChoiceHost />
    </>
  );
}

function TextHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    show = (a) => {
      setAsk(a);
      setValue(a.value ?? "");
    };
    return () => {
      show = null;
    };
  }, []);
  useEffect(() => {
    if (ask) requestAnimationFrame(() => input.current?.focus());
  }, [ask]);
  if (!ask) return null;
  const done = (v: string | null) => {
    ask.resolve(v);
    setAsk(null);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <div className="dialog" role="dialog">
        <h2>{ask.title}</h2>
        {ask.label && <p className="muted">{ask.label}</p>}
        {ask.multiline ? (
          <textarea
            ref={input}
            rows={6}
            value={value}
            placeholder={ask.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim()) done(value);
              if (e.key === "Escape") done(null);
            }}
          />
        ) : (
          <input
            ref={input}
            value={value}
            placeholder={ask.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && value.trim()) done(value);
              if (e.key === "Escape") done(null);
            }}
          />
        )}
        <div className="row">
          <span className="spacer" />
          <button onClick={() => done(null)}>Cancel</button>
          <button className="primary" disabled={!value.trim()} onClick={() => done(value)}>
            {ask.ok ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
