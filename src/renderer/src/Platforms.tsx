// Platforms in the window: the feature header's P1 · P2 · ＋ tabs, what an
// earlier platform delivered (and whether it still counts), and starting the
// next one. See src/main/core/platforms.ts.
import { useEffect, useState } from "react";
import { stageEmoji } from "../../shared/stages.ts";
import type { CurrentPlatform, Feature, FeatureOverview, PastPlatform } from "../../shared/types.ts";
import { repoLabel } from "./labels.ts";

const api = window.caboose;

/** Whether the current platform has delivered: a PR merged or closed, and none still open. */
export function platformDone(ov: FeatureOverview | null | undefined): boolean {
  if (!ov?.repos.some((r) => r.pr?.state === "MERGED" || r.pr?.state === "CLOSED")) return false;
  return ov.repos.every((r) => r.pr?.state !== "OPEN" && r.pr?.state !== "DRAFT");
}

/** What is still in the way of the next platform: work that would be left behind (the main process checks again). */
function leftBehind(ov: FeatureOverview | null): string[] {
  return (ov?.repos ?? []).flatMap((r) => [
    ...(r.local?.uncommitted ? [`${repoLabel(r.name)} has ${r.local.uncommitted} uncommitted change(s): commit or discard them`] : []),
    ...(!r.pr && r.local?.aheadBase ? [`${repoLabel(r.name)} has ${r.local.aheadBase} commit(s) that were never merged (no PR)`] : []),
  ]);
}

const current = (f: Feature): CurrentPlatform => f.platform ?? { n: 1, startedAt: f.createdAt };
const day = (iso: string) => iso.slice(0, 10);

/** P1 · P2 … (the current one marked), and ＋ once the current one's work is merged or closed. */
export function PlatformStrip({ f, ov, onNext }: { f: Feature; ov: FeatureOverview | null; onNext: () => void }) {
  const cur = current(f);
  const past = f.platforms ?? [];
  const ready = !f.archived && platformDone(ov);
  if (!past.length && !ready) return null;
  return (
    <span className="platform-strip">
      {past.map((p) => (
        <PastChip key={p.n} f={f} p={p} />
      ))}
      {(past.length > 0 || cur.n > 1) && (
        <span className="platform-chip current" title={`Platform ${cur.n}, now (since ${day(cur.startedAt)})${cur.goal ? `: ${cur.goal}` : ""}`}>
          P{cur.n}
          {cur.goal && <span className="platform-goal">{cur.goal}</span>}
        </span>
      )}
      {ready && (
        <button className="platform-chip next" onClick={onNext} title={`Platform ${cur.n}'s work is merged: start platform ${cur.n + 1} (a new wave of this feature, with its own branches; the chats carry on)`}>
          ＋ platform
        </button>
      )}
    </span>
  );
}

function PastChip({ f, p }: { f: Feature; p: PastPlatform }) {
  const [open, setOpen] = useState(false);
  const shipped = (p.releases ?? []).every((r) => r.stages.every((s) => r.release.some((x) => x.stage === s && x.tags.length)));
  return (
    <span className="info-wrap">
      <button className={`platform-chip${p.superseded ? " superseded" : ""}`} onClick={() => setOpen(!open)} title={`Platform ${p.n}${p.goal ? `: ${p.goal}` : ""}${p.superseded ? " (superseded)" : ""}`}>
        P{p.n}
        {p.superseded ? " ✗" : p.releases?.length ? (shipped ? " ✓" : " …") : ""}
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="popover platform-popover">
            <div>
              <b>
                Platform {p.n}
                {p.goal ? `: ${p.goal}` : ""}
              </b>
              {p.superseded && <span className="muted"> · superseded</span>}
            </div>
            <div className="muted small">
              {day(p.startedAt)} – {day(p.endedAt)}
            </div>
            <table className="platform-repos">
              <tbody>
                {p.repos.map((r) => {
                  const rel = p.releases?.find((x) => x.repo === r.name);
                  return (
                    <tr key={r.name}>
                      <td>{repoLabel(r.name)}</td>
                      <td>
                        {r.pr ? (
                          <button className="link" onClick={() => void api.openUrl(r.pr!.url)} title={r.branch}>
                            #{r.pr.number} {r.pr.state.toLowerCase()}
                          </button>
                        ) : (
                          <span className="muted" title={r.branch}>
                            no PR
                          </span>
                        )}
                      </td>
                      <td className="muted">{r.jira ?? ""}</td>
                      <td>
                        {rel?.stages.map((s) => {
                          const tags = rel.release.find((x) => x.stage === s)?.tags ?? [];
                          return (
                            <span key={s} className={`platform-stage${tags.length ? " reached" : ""}`} title={tags.length ? `${s}: ${tags.join(", ")}` : `${s}: not yet`}>
                              {stageEmoji(s)} {s}
                              {tags.length ? " ✓" : ""}
                            </span>
                          );
                        })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!f.archived && (
              <div className="row">
                <span className="muted small">
                  {p.superseded ? "Its releases no longer count." : p.releases?.length ? "Its releases are followed until they reach every stage." : "Nothing of it was merged."}
                </span>
                <span className="spacer" />
                <button
                  onClick={async () => {
                    const r = await api.supersedePlatform(f.id, p.n, !p.superseded);
                    if (!r.ok) alert(r.error);
                    setOpen(false);
                  }}
                  title={p.superseded ? "Count its releases again" : "A later platform replaces it (a wrong revision, or work dropped): stop following its releases"}
                >
                  {p.superseded ? "Count it again" : "Mark superseded"}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </span>
  );
}

/** The next platform: its goal, its repos (the current ones, and others from the line), and how Jira tracks it. */
export function NextPlatformDialog(props: { f: Feature; ov: FeatureOverview | null; hasTask: boolean; onCancel: () => void; onDone: () => void }) {
  const { f } = props;
  const blockers = leftBehind(props.ov);
  const n = current(f).n + 1;
  const [goal, setGoal] = useState("");
  const [addable, setAddable] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(f.repos.map((r) => r.name)));
  const [jira, setJira] = useState<"own" | "reuse">("own");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api.addableRepos(f.id).then(setAddable), [f.id]);
  const [joining, setJoining] = useState<string[]>([]);
  const repos = [...f.repos.map((r) => r.name), ...joining];
  const others = addable.filter((a) => !repos.includes(a));
  const go = async () => {
    setBusy(true);
    setError(null);
    const r = await api.nextPlatform(f.id, { ...(goal.trim() ? { goal: goal.trim() } : {}), repos: repos.filter((x) => picked.has(x)), ...(props.hasTask ? { jira } : {}) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    if (r.value.warnings.length) alert(`Platform ${r.value.n} has started, with problems:\n\n${r.value.warnings.join("\n")}`);
    props.onDone();
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onCancel()}>
      <div className="dialog" role="dialog">
        <h2>Platform {n}</h2>
        <p className="muted">
          A new wave of this feature. Platform {n - 1} is kept with its PRs, and its releases are followed until they reach prod (unless you mark it
          superseded). Each repo here gets a new branch from its base; repos that were in platform {n - 1} keep their folder, so their chats carry on.
        </p>
        <label className="form-row">
          <span>Goal</span>
          <input autoFocus value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Refine the data, or: Fix the receipt layout" />
        </label>
        <div className="continue-repos">
          {repos.map((name) => (
            <label key={name} title={f.repos.some((r) => r.name === name) ? `In platform ${n - 1}` : "Joins in this platform"}>
              <input
                type="checkbox"
                checked={picked.has(name)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(name);
                  else next.delete(name);
                  setPicked(next);
                }}
              />
              {repoLabel(name)}
              {!f.repos.some((r) => r.name === name) && <span className="muted small"> joins</span>}
            </label>
          ))}
          {others.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const name = e.target.value;
                if (!name) return;
                setJoining([...joining, name]);
                setPicked(new Set(picked).add(name));
              }}
            >
              <option value="">+ add a repo…</option>
              {others.map((a) => (
                <option key={a} value={a}>
                  {repoLabel(a)}
                </option>
              ))}
            </select>
          )}
        </div>
        {props.hasTask && (
          <div className="platform-jira">
            <label>
              <input type="radio" checked={jira === "own"} onChange={() => setJira("own")} /> <b>Tracked on its own</b>
              <span className="muted"> — a new Jira subtask per repo for this platform</span>
            </label>
            <label>
              <input type="radio" checked={jira === "reuse"} onChange={() => setJira("reuse")} /> <b>Same subtasks</b>
              <span className="muted"> — the task and the repos' subtasks go back to In Progress</span>
            </label>
          </div>
        )}
        {blockers.length > 0 && (
          <div className="del">
            Platform {n - 1} still has work that would be left behind:
            <ul>
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        )}
        {error && <div className="del">{error}</div>}
        <div className="row">
          <span className="spacer" />
          <button onClick={props.onCancel}>Cancel</button>
          <button className="primary" disabled={busy || !picked.size || blockers.length > 0} onClick={() => void go()}>
            {busy ? "Starting…" : `Start platform ${n}`}
          </button>
        </div>
      </div>
    </div>
  );
}
