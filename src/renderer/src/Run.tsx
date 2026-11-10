import { useEffect, useRef, useState } from "react";
import type { AzureStatus, Feature, PortHolder, RunOverview, RunRepo, RunScript, Terminal } from "../../shared/types.ts";
import { repoLabel } from "./labels.ts";
import { stationLabel } from "../../shared/stations.ts";
import { dispatch } from "./commands.ts";

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
  const azure = useAzure(f.id, Boolean(props.ov?.azureTenants?.length));
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
      {ov.azureTenants && azure.statuses && (
        <AzureBar
          statuses={only ? azure.statuses.filter((s) => ov.repos.some((r) => r.scripts.some((x) => x.azure === s.tenant))) : azure.statuses}
          signingIn={azure.signingIn}
          onSignIn={(t) => void azure.signIn(t)}
          onRefresh={() => void azure.load(true)}
        />
      )}
      {ov.strayError && (
        <div className="muted small" title={ov.strayError}>
          Programs started outside Caboose cannot be seen on this machine (needs lsof or ss; PowerShell on Windows).
        </div>
      )}
      <div className="plan-section">
        {ov.repos.map((r) => (
          <RepoRun key={r.repo} f={f} r={r} disabled={!!busy || !!f.archived} act={act} onShow={props.onShow} inRepoTab={Boolean(only)} azure={ov.azureTenants ? { tenants: ov.azureTenants, ...azure } : undefined} />
        ))}
      </div>
    </div>
  );
}

type Act = (label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) => Promise<void>;

/** The line's Azure tenants: their sign-ins (checked now and every 5 minutes), and signing in. */
function useAzure(featureId: string, wanted: boolean) {
  const [statuses, setStatuses] = useState<AzureStatus[] | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const load = async (fresh = false) => setStatuses(await api.azureStatus(featureId, fresh));
  useEffect(() => {
    if (!wanted) return;
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    return () => clearInterval(t);
  }, [featureId, wanted]);
  /** az login to the tenant; true when it is signed in after. */
  const signIn = async (tenant: string): Promise<boolean> => {
    setSigningIn(tenant);
    try {
      const r = await api.azureLogin(featureId, tenant);
      if (!r.ok) alert(`Signing in to ${tenant} failed: ${r.error}`);
      await load();
      return r.ok && r.value.state === "ok";
    } finally {
      setSigningIn(null);
    }
  };
  return { statuses, signingIn, signIn, load };
}

type Azure = ReturnType<typeof useAzure> & { tenants: string[] };

const AZURE_TEXT: Record<AzureStatus["state"], string> = {
  ok: "signed in",
  expired: "sign-in expired",
  none: "not signed in",
  "no-cli": "no Azure CLI",
  error: "cannot tell",
};

/** One chip per tenant: signed in (and as whom), or a button to sign in. */
function AzureBar(props: { statuses: AzureStatus[]; signingIn: string | null; onSignIn: (tenant: string) => void; onRefresh: () => void }) {
  if (!props.statuses.length) return null;
  return (
    <div className="azure-bar">
      <span className="muted small">Azure</span>
      {props.statuses.map((s) => (
        <span
          key={s.tenant}
          className={`azure-chip az-${s.state}`}
          title={`${s.tenant} (${s.tenantId}): ${AZURE_TEXT[s.state]}${s.user ? ` as ${s.user}` : ""}${s.detail ? `\n${s.detail}` : ""}\nStore: ${s.configDir}\nChecked ${s.checkedAt.slice(11, 16)}`}
        >
          <span className="az-dot" />
          <b>{s.tenant}</b>
          <span className="small">{s.state === "ok" ? (s.user ?? "signed in") : AZURE_TEXT[s.state]}</span>
          {s.state !== "no-cli" &&
            (props.signingIn === s.tenant ? (
              <span className="muted small">signing in in the browser…</span>
            ) : (
              <button className="link small" disabled={!!props.signingIn} onClick={() => props.onSignIn(s.tenant)} title={`az login --tenant ${s.tenantId}, into ${s.configDir}`}>
                {s.state === "ok" ? "sign in again" : "Sign in"}
              </button>
            ))}
        </span>
      ))}
      <button className="icon" title="Check the sign-ins again" onClick={props.onRefresh}>
        ↻
      </button>
    </div>
  );
}

function RepoRun(props: { f: Feature; r: RunRepo; disabled: boolean; act: Act; onShow: (id: string) => void; inRepoTab: boolean; azure?: Azure }) {
  const { f, r, disabled, act, onShow } = props;
  const idle = r.scripts.filter((s) => s.state !== "running");
  const running = r.scripts.some((s) => s.state === "running");
  // Say each name once: no moniker chip when it is the repo's name, and a script named after the repo is just "run".
  const same = (a?: string) => Boolean(a) && [r.repo, repoLabel(r.repo), r.moniker].some((n) => n?.toLowerCase() === a!.toLowerCase());
  const showMoniker = r.moniker && !same2(r.moniker, [r.repo, repoLabel(r.repo)]);
  return (
    <div className="run-repo">
      {/* In the repo's own tab the tab names it; the toolbar has "Run all". */}
      {!props.inRepoTab && (
        <div className="run-repo-line">
          <span className={`dot${running ? " run-running" : ""}`} />
          {showMoniker && (
            <span className="moniker" title={r.description}>
              {r.moniker}
            </span>
          )}
          <b className="repo-name-cell" title={r.path}>
            {repoLabel(r.repo)}
          </b>
          {r.scripts.length > 1 && idle.length > 0 && (
            <button className="small-btn" disabled={disabled} onClick={() => act("Starting", () => api.runStartAll(f.id, r.repo))} title={`Start every program of ${r.repo}`}>
              ▶ all
            </button>
          )}
        </div>
      )}
      <div className="run-scripts">
        {r.scripts.length === 0 && <span className="muted small">No run.sh or run_*.sh, and no run script in Configure.</span>}
        {r.scripts.map((s) => (
          <ScriptChip key={s.id} f={f} repo={r.repo} s={same(s.label) ? { ...s, label: "run" } : s} strays={r.strays} disabled={disabled} act={act} onShow={onShow} azure={props.azure} />
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

const same2 = (a: string, names: string[]) => names.some((n) => n.toLowerCase() === a.toLowerCase());

function ScriptChip(props: { f: Feature; repo: string; s: RunScript; strays: PortHolder[]; disabled: boolean; act: Act; onShow: (id: string) => void; azure?: Azure }) {
  const { f, repo, s, disabled, act, azure } = props;
  const what = `${s.description ? `${s.description}\n` : ""}${s.command}${s.azure ? `\nAzure: ${s.azure}` : ""}`;
  const signIn = azure?.statuses?.find((x) => x.tenant === s.azure);
  /** Starts it; when its tenant is not signed in, offers to sign in first. */
  const start = () =>
    act(`Starting ${s.label}`, async () => {
      if (signIn && azure && signIn.state !== "ok" && signIn.state !== "no-cli") {
        if (confirm(`${s.label} signs in to Azure as ${s.azure}, which is ${AZURE_TEXT[signIn.state]}.\n\nSign in to ${s.azure} first? (Cancel starts it anyway.)`)) {
          await azure.signIn(s.azure!);
        }
      }
      return api.runStart(f.id, repo, s.id);
    });
  const chip =
    s.state === "stopped" ? (
      <button
        className={`run-chip${s.elsewhere ? " elsewhere" : ""}`}
        disabled={disabled}
        title={`Start: ${what}${s.elsewhere ? `\n\nAlready running in ${s.elsewhere.map((e) => stationLabel(e.feature)).join(", ")}: it probably holds the port, so this one may not start.` : ""}`}
        onClick={() => void start()}
      >
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
            <button className="icon" disabled={disabled} title="Run it again" onClick={() => void start()}>
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
      {azure && (
        <AzurePick
          s={s}
          tenants={azure.tenants}
          status={signIn}
          disabled={disabled}
          onPick={(tenant) =>
            act("Saving", async () => {
              const r = await api.azureSubscribe(f.id, repo, s.id, tenant);
              if (r.ok && s.state === "running" && s.terminalId && confirm(`${s.label} is running with ${s.azure ?? "no Azure tenant"}. Restart it now so it signs in with ${tenant ?? "none"}?`)) {
                await api.runStop(s.terminalId);
                return api.runStart(f.id, repo, s.id);
              }
              return r;
            })
          }
        />
      )}
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
      {s.state !== "running" &&
        s.elsewhere?.map((e) => (
          <button
            key={e.featureId}
            className="run-elsewhere"
            title={`${s.label} is already running in ${stationLabel(e.feature)}: it probably holds the port. Click to go there.`}
            onClick={() => dispatch(`openFeature:${e.featureId}`)}
          >
            ⚠ running in {stationLabel(e.feature)}
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

/** Which Azure tenant a program signs in with; its dot says whether that sign-in works. */
function AzurePick(props: { s: RunScript; tenants: string[]; status?: AzureStatus; disabled: boolean; onPick: (tenant: string | null) => void }) {
  const { s, status } = props;
  return (
    <span
      className={`azure-pick${s.azure ? ` az-${status?.state ?? "unknown"}` : " az-off"}`}
      title={
        s.azure
          ? `${s.label} signs in to Azure as ${s.azure}${status ? ` (${AZURE_TEXT[status.state]}${status.user ? `: ${status.user}` : ""})` : ""}: it starts with that tenant's store as AZURE_CONFIG_DIR.`
          : `Which Azure tenant ${s.label} signs in to (az, AzureCliCredential): it starts with that tenant's store as AZURE_CONFIG_DIR.`
      }
    >
      {s.azure && <span className="az-dot" />}
      <select value={s.azure ?? ""} disabled={props.disabled} onChange={(e) => props.onPick(e.target.value || null)}>
        <option value="">{s.azure ? "no Azure" : "Azure…"}</option>
        {props.tenants.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </span>
  );
}
