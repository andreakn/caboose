// What runs where, from a repo's .caboose/running.sh: a chip per environment
// in the repo's row (✓ once the release running there has the merged change),
// and behind it every component's version and the choice of which components
// this feature touches (only those are shown and counted).
import { useState } from "react";
import { relevantVersions } from "../../shared/stages.ts";
import type { Feature, RepoOverview, RunningVersion } from "../../shared/types.ts";

const api = window.caboose;

/** The environments in the order the script lists them. */
const envsOf = (vs: RunningVersion[]) => [...new Set(vs.map((v) => v.env))];
const mark = (v: RunningVersion) => (v.contains === true ? "✓" : v.contains === false ? "–" : "");

export function RunningChips({ feature, ov, onChanged }: { feature: Feature; ov: RepoOverview; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const running = ov.running;
  if (!running) return null;
  const shown = relevantVersions(running, ov.components);
  const all = [...new Set(running.versions.map((v) => v.component).filter(Boolean))];

  const chip = (env: string) => {
    const vs = shown.filter((v) => v.env === env);
    const known = vs.every((v) => v.contains !== undefined);
    const ok = known && vs.every((v) => v.contains);
    const text = vs.length === 1 ? vs[0].version : `${vs.length} components`;
    return (
      <span
        key={env}
        className={`chip running${!known ? "" : ok ? " ok" : " behind"}`}
        title={`Running in ${env}:\n${vs.map((v) => `${mark(v)} ${v.component ? `${v.component}: ` : ""}${v.version}`).join("\n")}${!known ? "" : ok ? "\nThis feature's change runs here." : "\nNot running here yet."}`}
      >
        ▶ {env} {known ? (ok ? "✓" : "–") : <span className="running-version">{text}</span>}
      </span>
    );
  };

  return (
    <span className="info-wrap running-chips" onClick={(e) => e.stopPropagation()}>
      <button className="link chip-button" onClick={() => setOpen(!open)} title="What runs where (from .caboose/running.sh)">
        {running.error && !shown.length ? <span className="chip running behind">▶ ?</span> : envsOf(shown).map(chip)}
      </button>
      {open && (
        <>
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="popover running-popover">
            <RunningTable versions={shown} />
            {running.error && <div className="del small">Could not tell everything: {running.error}</div>}
            {all.length > 1 && <ComponentPicker feature={feature} repo={ov.name} all={all} chosen={ov.components} onChanged={onChanged} />}
          </div>
        </>
      )}
    </span>
  );
}

function RunningTable({ versions }: { versions: RunningVersion[] }) {
  const envs = envsOf(versions);
  const components = [...new Set(versions.map((v) => v.component))];
  if (!versions.length) return <div className="muted">Nothing reported.</div>;
  return (
    <table className="running-table">
      <thead>
        <tr>
          <th />
          {envs.map((e) => (
            <th key={e}>{e}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {components.map((c) => (
          <tr key={c}>
            <th>{c || "running"}</th>
            {envs.map((e) => {
              const v = versions.find((x) => x.component === c && x.env === e);
              return (
                <td key={e} className={v?.contains === true ? "add" : v?.contains === false ? "muted" : ""} title={v?.tag ? `release tag ${v.tag}` : v?.commit ? `commit ${v.commit.slice(0, 12)} (untagged)` : v ? "no tag or commit found for this version" : undefined}>
                  {v ? `${mark(v)} ${v.version}` : ""}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Which of the repo's components this feature touches. */
function ComponentPicker(props: { feature: Feature; repo: string; all: string[]; chosen?: string[]; onChanged: () => void }) {
  const chosen = new Set(props.chosen ?? []);
  const save = async (next: Set<string>) => {
    const r = await api.setComponents(props.feature.id, props.repo, next.size && next.size < props.all.length ? [...next] : null);
    if (!r.ok) alert(r.error);
    props.onChanged();
  };
  return (
    <div className="component-picker">
      <div className="muted small">{chosen.size ? "This feature touches:" : "Which components does this feature touch? (all count until you choose)"}</div>
      {props.all.map((c) => (
        <label key={c}>
          <input
            type="checkbox"
            checked={chosen.has(c)}
            disabled={props.feature.archived}
            onChange={(e) => {
              const next = new Set(chosen);
              if (e.target.checked) next.add(c);
              else next.delete(c);
              void save(next);
            }}
          />
          {c}
        </label>
      ))}
    </div>
  );
}
