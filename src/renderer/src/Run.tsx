import { useEffect, useRef, useState } from "react";
import type { Feature, PortHolder, RunOverview, RunRepo, RunScript, Terminal } from "../../shared/types.ts";

const api = window.caboose;

/** Every repo's programs (run.sh, run_<moniker>.sh, configured run scripts): start, stop, open their URLs. */
export function useRunOverview(f: Feature, terminals: Terminal[], active: boolean) {
  const [ov, setOv] = useState<RunOverview | null>(null);
  const seq = useRef(0);
  const load = async () => {
    const n = ++seq.current;
    const v = await api.runOverview(f.id);
    if (n === seq.current) setOv(v);
  };
  const runKey = terminals
    .filter((t) => t.featureId === f.id && t.kind === "run")
    .map((t) => `${t.id}:${t.exitCode ?? ""}`)
    .join();
  const repoKey = f.repos.map((r) => r.name).join();
  useEffect(() => void load(), [f.id, runKey, repoKey]);
  // Programs started or stopped elsewhere (a terminal, an agent) show up while the tab is open.
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [f.id, active]);
  return { ov, reload: load };
}

export function RunView(props: {
  f: Feature;
  ov: RunOverview | null;
  reload: () => Promise<void>;
  onShow: (terminalId: string) => void;
  /** Only this repo's programs (the repo's own Run tab). */
  only?: string;
}) {
  const { f, reload, only } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const ov = props.ov && only ? { ...props.ov, repos: props.ov.repos.filter((r) => r.repo === only) } : props.ov;
  if (!ov) return <div className="changes-empty muted">Loading…</div>;
  const all = ov.repos.flatMap((r) => r.scripts);
  const running = all.filter((s) => s.state === "running").length;
  const idle = all.filter((s) => s.state !== "running").length;
  const strays = ov.repos.reduce((n, r) => n + r.strays.length, 0);

  /** Runs an action, showing `label` meanwhile and any error after. */
  const act = async (label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) => {
    setBusy(label);
    try {
      const r = await fn();
      if (r && !r.ok) alert(r.error);
    } finally {
      setBusy(null);
      await reload();
    }
  };

  if (!f.repos.length) return <div className="changes-empty muted">No repos in this feature yet.</div>;
  return (
    <div className="plan-view run-view">
      <div className="tiles">
        <div className={`tile${running ? " good" : ""}`}>
          <b>{running}</b>
          <span>running</span>
        </div>
        <div className="tile">
          <b>{all.length}</b>
          <span>programs</span>
        </div>
        {strays > 0 && (
          <div className="tile bad" title="Listening from this feature's worktrees, but not started here">
            <b>{strays}</b>
            <span>outside the Run tab</span>
          </div>
        )}
        <span className="spacer" />
        {busy && <span className="muted small">{busy}…</span>}
        {idle > 0 && !f.archived && (
          <button
            className="primary"
            disabled={!!busy}
            onClick={() => act("Starting", () => api.runStartAll(f.id, only))}
            title={only ? `Start every program of ${only} that is not running` : "Start every program that is not running (Cmd/Ctrl+R)"}
          >
            {only ? "▶ Run all" : "▶ Run feature"}
          </button>
        )}
        {running > 0 && (
          <button
            disabled={!!busy}
            onClick={() =>
              act("Stopping", async () => {
                if (!only) return api.runStopAll(f.id);
                await Promise.all(all.filter((s) => s.state === "running" && s.terminalId).map((s) => api.runStop(s.terminalId!)));
              })
            }
            title="Ctrl-C every running program, then close their terminals"
          >
            ■ Stop all
          </button>
        )}
      </div>
      {ov.strayError && (
        <div className="muted small" title={ov.strayError}>
          Programs started outside Caboose cannot be seen on this machine (needs lsof or ss; PowerShell on Windows).
        </div>
      )}
      <div className="plan-section">
        {ov.repos.map((r) => (
          <RepoRun key={r.repo} f={f} r={r} disabled={!!busy || !!f.archived} act={act} onShow={props.onShow} />
        ))}
      </div>
    </div>
  );
}

type Act = (label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) => Promise<void>;

function RepoRun({ f, r, disabled, act, onShow }: { f: Feature; r: RunRepo; disabled: boolean; act: Act; onShow: (id: string) => void }) {
  const idle = r.scripts.filter((s) => s.state !== "running");
  const running = r.scripts.some((s) => s.state === "running");
  return (
    <div className="run-repo">
      <div className="run-repo-line">
        <span className={`dot${running ? " run-running" : ""}`} />
        {r.moniker && (
          <span className="moniker" title={r.description}>
            {r.moniker}
          </span>
        )}
        <b className="repo-name-cell" title={r.path}>
          {r.repo}
        </b>
        {r.scripts.length > 1 && idle.length > 0 && (
          <button className="small-btn" disabled={disabled} onClick={() => act("Starting", () => api.runStartAll(f.id, r.repo))} title={`Start every program of ${r.repo}`}>
            ▶ all
          </button>
        )}
      </div>
      <div className="run-scripts">
        {r.scripts.length === 0 && <span className="muted small">No run.sh or run_*.sh, and no run script in Configure.</span>}
        {r.scripts.map((s) => (
          <ScriptChip key={s.id} f={f} repo={r.repo} s={s} strays={r.strays} disabled={disabled} act={act} onShow={onShow} />
        ))}
      </div>
      {r.strays.length > 0 && (
        <div className="run-strays">
          {r.strays.map((h) => (
            <Holder key={h.pid} f={f} h={h} lead="Running outside the Run tab:" act={act} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScriptChip(props: { f: Feature; repo: string; s: RunScript; strays: PortHolder[]; disabled: boolean; act: Act; onShow: (id: string) => void }) {
  const { f, repo, s, disabled, act } = props;
  const what = `${s.description ? `${s.description}\n` : ""}${s.command}`;
  const chip =
    s.state === "stopped" ? (
      <button className="run-chip" disabled={disabled} title={`Start: ${what}`} onClick={() => act(`Starting ${s.label}`, () => api.runStart(f.id, repo, s.id))}>
        ▶ {s.label}
      </button>
    ) : (
      <span className={`run-chip run-${s.state}`} title={`${what}\n${s.state === "running" ? "running" : `exited with code ${s.exitCode}`}`}>
        <span className="dot" />
        <button className="link" title="Show its terminal" onClick={() => s.terminalId && props.onShow(s.terminalId)}>
          {s.label}
        </button>
        {s.state === "exited" && (
          <>
            <span className="muted small">exit {s.exitCode}</span>
            <button className="icon" disabled={disabled} title="Run it again" onClick={() => act(`Starting ${s.label}`, () => api.runStart(f.id, repo, s.id))}>
              ↻
            </button>
          </>
        )}
        <button
          className="icon"
          title={s.state === "running" ? "Stop (Ctrl-C) and close its terminal" : "Close its terminal"}
          onClick={() => act(`Stopping ${s.label}`, () => api.runStop(s.terminalId!))}
        >
          ■
        </button>
      </span>
    );
  return (
    <span className="run-group">
      {chip}
      {s.urls.map((u) => (
        <button
          key={u.url}
          className={`run-chip browse${s.state === "running" ? "" : " idle"}`}
          title={`Open ${u.url}${s.state === "running" ? "" : ` (${s.label} is not running)`}`}
          onClick={() => act("Opening", () => api.runBrowse(f.id, repo, s.id, u.url))}
        >
          🌐{u.label ? ` ${u.label}` : ""}
        </button>
      ))}
      {s.busy
        ?.filter((h) => !props.strays.some((x) => x.pid === h.pid))
        .map((h) => <Holder key={h.pid} f={f} h={h} lead={`port ${h.ports.join(", ")} is taken by`} act={act} />)}
    </span>
  );
}

/** A program holding a port, with a stop button when Caboose may stop it. */
function Holder({ f, h, lead, act }: { f: Feature; h: PortHolder; lead: string; act: Act }) {
  return (
    <span className="run-holder small" title={`pid ${h.pid}: ${h.command}`}>
      ⚠ {lead} <b>{h.name}</b>
      {lead.startsWith("port") ? "" : ` :${h.ports.join(", :")}`}
      {h.where ? ` (${h.where})` : ""}
      {h.stoppable && (
        <button className="icon" title={`Stop pid ${h.pid}`} onClick={() => act(`Stopping ${h.name}`, () => api.runStopHolder(f.id, h.pid))}>
          ■
        </button>
      )}
    </span>
  );
}
