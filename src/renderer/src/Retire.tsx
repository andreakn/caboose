import { useEffect, useState } from "react";
import type { Feature, Result, RetireMode, RetireOutcome, RetirePlan } from "../../shared/types.ts";
import { repoLabel } from "./labels.ts";
import { stationLabel } from "../../shared/stations.ts";

const api = window.caboose;

/**
 * Archive or delete a feature. Both close its open PRs and delete its
 * branches; archive moves the folder and chat logs to the archive folder,
 * delete deletes them. Shows first what would be lost.
 */
export function RetireDialog(props: {
  f: Feature;
  onDone: (mode: RetireMode, r: Result<RetireOutcome>) => void;
  onCancel: () => void;
}) {
  const { f } = props;
  const [plan, setPlan] = useState<RetirePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<RetireMode | null>(null);

  useEffect(() => {
    void api.retirePlan(f.id).then((r) => (r.ok ? setPlan(r.value) : setError(r.error)));
  }, [f.id]);

  async function go(mode: RetireMode) {
    if (mode === "delete" && !confirm(`Delete ${stationLabel(f.name)} for good? Its folder and chat logs are not kept anywhere.`)) return;
    setBusy(mode);
    const r = await api.retireFeature(f.id, mode);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    props.onDone(mode, r);
  }

  const open = plan?.repos.filter((r) => r.pr && (r.pr.state === "OPEN" || r.pr.state === "DRAFT")) ?? [];
  const losing = plan?.repos.filter((r) => r.uncommitted || r.unpushed) ?? [];

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && props.onCancel()}>
      <div className="dialog retire-dialog" role="dialog" onKeyDown={(e) => e.key === "Escape" && !busy && props.onCancel()}>
        <h2>
          Archive or delete {stationLabel(f.name)}
          {f.title ? <span className="muted"> · {f.title}</span> : null}
        </h2>
        {!plan && !error && <div className="muted">Looking at its repos, branches and PRs…</div>}
        {plan && (
          <>
            <p className="muted small">Either way, its open PRs are closed and its branches deleted, here and on GitHub.</p>
            <div className="retire-repos">
              {plan.repos.length === 0 && <div className="muted small">No repos.</div>}
              {plan.repos.map((r) => (
                <div key={r.repo} className="retire-repo">
                  <div>
                    <b>{repoLabel(r.repo)}</b> <code>{r.branch}</code>{" "}
                    {r.keepBranch ? <span className="muted small">kept ({r.keepBranch})</span> : <span className="muted small">deleted</span>}
                  </div>
                  {r.pr && (
                    <div className="small">
                      PR #{r.pr.number} {r.pr.title ? <span className="muted">{r.pr.title}</span> : null} ·{" "}
                      {r.pr.state === "OPEN" || r.pr.state === "DRAFT" ? (
                        <b className="del">{r.pr.state.toLowerCase()}: will be closed</b>
                      ) : (
                        <span className="muted">{r.pr.state.toLowerCase()}</span>
                      )}
                    </div>
                  )}
                  {r.prError && <div className="small del">PR unknown: {r.prError}</div>}
                  {(r.uncommitted > 0 || r.unpushed > 0) && (
                    <div className="small del">
                      ⚠ lost:{" "}
                      {[r.uncommitted && `${r.uncommitted} uncommitted change(s)`, r.unpushed && `${r.unpushed} unpushed commit(s)`].filter(Boolean).join(", ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className="small">
              <b>Archive</b> moves the feature folder (brief, plan, log) and its chat logs to <code>{plan.archiveTo}</code>.{" "}
              <b>Delete</b> deletes them.
            </p>
            {(open.length > 0 || losing.length > 0) && (
              <p className="small del">
                {open.length > 0 && `${open.length} open PR(s) will be closed. `}
                {losing.length > 0 && `Work in ${losing.map((r) => r.repo).join(", ")} is not pushed and will be lost.`}
              </p>
            )}
          </>
        )}
        {error && <div className="del">{error}</div>}
        <div className="row">
          {busy && <span className="muted small">{busy === "archive" ? "Archiving" : "Deleting"}…</span>}
          <span className="spacer" />
          <button onClick={props.onCancel} disabled={!!busy}>
            Cancel
          </button>
          <button className="danger" disabled={!plan || !!busy} onClick={() => void go("delete")}>
            Delete
          </button>
          <button className="primary" disabled={!plan || !!busy} onClick={() => void go("archive")} autoFocus>
            Archive
          </button>
        </div>
      </div>
    </div>
  );
}
