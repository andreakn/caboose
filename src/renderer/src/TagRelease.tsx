// Cutting the next release tag for a repo whose releases are tags: what the
// base branch's tip is, each tag prefix's latest and next version, the ones
// this feature touches ticked; then tag and push.
import { useEffect, useState } from "react";
import type { Feature, RepoOverview } from "../../shared/types.ts";
import { repoLabel } from "./labels.ts";

const api = window.caboose;

type Plan = { base: string; commit: string; subject: string; prefixes: { prefix: string; latest: string; next: string }[] };

/** Whether a tag prefix (cdsws) belongs to one of the components the feature touches (cds, cdsws). */
const touches = (prefix: string, components: string[]) =>
  components.some((c) => prefix.toLowerCase() === c.toLowerCase() || prefix.toLowerCase().startsWith(c.toLowerCase()));

export function TagReleaseDialog({ f, repo, ov, onClose, onDone }: { f: Feature; repo: string; ov?: RepoOverview; onClose: () => void; onDone: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);

  useEffect(() => {
    void api.releasePlan(f.id, repo).then((r) => {
      if (!r.ok) return setError(r.error);
      setPlan(r.value);
      // Preselect: the prefixes of the components this feature touches, else the only one.
      const mine = r.value.prefixes.filter((p) => touches(p.prefix, ov?.components ?? []));
      setPicked(new Set((mine.length ? mine : r.value.prefixes.length === 1 ? r.value.prefixes : []).map((p) => p.prefix)));
    });
  }, [f.id, repo]);

  const merged = ov?.pr?.state === "MERGED";
  const go = async () => {
    if (!plan) return;
    const tagged: string[] = [];
    for (const p of plan.prefixes.filter((x) => picked.has(x.prefix))) {
      setBusy(`Tagging ${p.next}…`);
      const r = await api.tagRelease(f.id, repo, p.prefix);
      if (!r.ok) {
        setBusy(null);
        setDone(tagged);
        return setError(r.error);
      }
      tagged.push(r.value.tag);
    }
    setBusy(null);
    setDone(tagged);
    onDone();
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="dialog tag-dialog" role="dialog">
        <h2>Tag a release of {repoLabel(repo)}</h2>
        {!plan && !error && <p className="muted">Fetching origin…</p>}
        {plan && (
          <>
            <p>
              On <code>origin/{plan.base}</code> at <code>{plan.commit.slice(0, 8)}</code>: {plan.subject}
            </p>
            {!merged && <p className="del small">This feature's PR is not merged yet, so the release would not have its change.</p>}
            {plan.prefixes.length === 0 ? (
              <p className="muted">No release tags like &lt;name&gt;_v1.234 here yet to count up from. Tag the first one by hand.</p>
            ) : (
              <div className="tag-prefixes">
                {plan.prefixes.map((p) => (
                  <label key={p.prefix} className={touches(p.prefix, ov?.components ?? []) ? "mine" : ""}>
                    <input
                      type="checkbox"
                      checked={picked.has(p.prefix)}
                      disabled={!!busy || done.length > 0}
                      onChange={(e) => {
                        const n = new Set(picked);
                        if (e.target.checked) n.add(p.prefix);
                        else n.delete(p.prefix);
                        setPicked(n);
                      }}
                    />
                    <code>{p.next}</code>
                    <span className="muted small">after {p.latest}</span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
        {error && <div className="del">{error}</div>}
        {done.length > 0 && <div className="add">Tagged and pushed: {done.join(", ")}. The deploy starts from the tag; Caboose follows it.</div>}
        <div className="row">
          {busy && <span className="muted">{busy}</span>}
          <span className="spacer" />
          <button onClick={onClose} disabled={!!busy}>
            {done.length ? "Close" : "Cancel"}
          </button>
          {!done.length && (
            <button className="primary" disabled={!plan || !picked.size || !!busy} onClick={() => void go()}>
              Tag and push {picked.size > 1 ? `${picked.size} tags` : ""}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
