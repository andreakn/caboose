// Configure → Lines: a line's own settings (a customer's Jira, folders,
// branch prefix, PR style, release tags). Shown once a repo is on a line.
// Everything left empty is the general setting, which the placeholders show.
import { useState } from "react";
import { formatStages } from "../../shared/stages.ts";
import { type ConfigInfo, type ConfigInput, JIRA_LEVELS, type JiraInput, type LineInput, RELEASE_STRATEGIES } from "../../shared/types.ts";
import { StagesEditor } from "./Configure.tsx";
import { askText } from "./Dialog.tsx";

const api = window.caboose;

type Props = {
  lines: string[];
  form: ConfigInput;
  setForm: (f: ConfigInput) => void;
  info: ConfigInfo;
  /** Saves the form; false when it did not. */
  save: () => Promise<boolean>;
};

export function LinesTab({ lines, form, setForm, info, save }: Props) {
  const setLine = (name: string, patch: Partial<LineInput>) => {
    const next = { ...(form.lines?.[name] ?? {}), ...patch };
    for (const k of Object.keys(next) as (keyof LineInput)[]) if (next[k] === undefined) delete next[k];
    setForm({ ...form, lines: { ...form.lines, [name]: next } });
  };

  /** A new name for a line: its repos and settings move with it (and its saved Jira token). */
  const rename = async (name: string) => {
    const to = (await askText({ title: `Rename the ${name} line`, label: "New name", value: name, ok: "Rename" }))?.trim();
    if (!to || to === name) return;
    if (lines.includes(to)) return alert(`There is already a line called ${to}.`);
    const { [name]: settings, ...others } = form.lines ?? {};
    const renamedFrom = settings?.renamedFrom ?? (info.config.lines?.[name] ? name : undefined);
    setForm({
      ...form,
      repos: (form.repos ?? []).map((r) => (r.line === name ? { ...r, line: to } : r)),
      lines: { ...others, [to]: { ...settings, ...(renamedFrom ? { renamedFrom } : {}) } },
    });
  };

  return (
    <>
      <section>
        <h2>Lines</h2>
        <p className="muted">
          Each line can have settings of its own, for example a customer's Jira and folders. Anything left empty is the general setting
          (shown faded). Repos are put on a line under Repositories.
        </p>
      </section>
      {lines.map((name) => (
        <LineSection
          key={name}
          name={name}
          repos={(form.repos ?? []).filter((r) => r.line === name).map((r) => r.label ?? r.name)}
          line={form.lines?.[name] ?? {}}
          form={form}
          info={info}
          savedToken={Boolean(info.config.lines?.[form.lines?.[name]?.renamedFrom ?? name]?.jira?.hasToken)}
          onChange={(patch) => setLine(name, patch)}
          onRename={() => void rename(name)}
          save={save}
        />
      ))}
    </>
  );
}

function LineSection(props: {
  name: string;
  repos: string[];
  line: LineInput;
  form: ConfigInput;
  info: ConfigInfo;
  savedToken: boolean;
  onChange: (patch: Partial<LineInput>) => void;
  onRename: () => void;
  save: () => Promise<boolean>;
}) {
  const { name, line, form, info } = props;
  const [test, setTest] = useState<string | null>(null);
  const jira = line.jira;
  const jiraMode = !jira ? "general" : jira.level === "off" ? "off" : "own";
  const setJira = (patch: Partial<JiraInput>) => props.onChange({ jira: { level: "optional", ...jira, ...patch } });
  const general = form.jira?.level && form.jira.level !== "off" ? `the general Jira (${form.jira.site ?? "not set up"})` : "no Jira (it is off in general)";
  const text = (key: "featuresRoot" | "archiveRoot" | "branchPrefix", label: string, fallback: string, hint?: string) => (
    <label>
      <span>{label}</span>
      <div className="row">
        <input value={line[key] ?? ""} placeholder={form[key] || fallback} onChange={(e) => props.onChange({ [key]: e.target.value || undefined })} />
        {key !== "branchPrefix" && (
          <button
            onClick={async () => {
              const folder = await api.pickFolder(`${label} for the ${name} line`);
              if (folder) props.onChange({ [key]: folder });
            }}
          >
            Choose…
          </button>
        )}
      </div>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );

  return (
    <section className="line-section">
      <div className="row">
        <h2>{name} line</h2>
        <span className="muted">{props.repos.join(", ")}</span>
        <span className="spacer" />
        <button className="link" onClick={props.onRename}>
          Rename…
        </button>
      </div>
      <div className="form">
        {text("featuresRoot", "Features folder", info.defaults.featuresRoot)}
        {text("archiveRoot", "Archive folder", info.defaults.archiveRoot)}
        {text("branchPrefix", "Branch prefix", info.defaults.branchPrefix, "Some customers want their own branch naming.")}
        <label>
          <span>Pull requests</span>
          <textarea
            className="wide"
            rows={Math.min(10, Math.max(3, (line.prInstructions ?? "").split("\n").length + 1))}
            value={line.prInstructions ?? ""}
            placeholder={form.prInstructions ? `As in general: ${form.prInstructions}` : "How this customer wants PRs written (empty: as in general)"}
            onChange={(e) => props.onChange({ prInstructions: e.target.value || undefined })}
          />
        </label>
        <label>
          <span>Releases are made by</span>
          <div>
            <select value={line.releaseStrategy ?? ""} onChange={(e) => props.onChange({ releaseStrategy: (e.target.value || undefined) as LineInput["releaseStrategy"] })}>
              <option value="">not said (each repo says)</option>
              {RELEASE_STRATEGIES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <small className="muted"> The default for this line's repos; a repo can say otherwise (its releases link under Repositories, or its .caboose/config.json).</small>
          </div>
        </label>
        <label>
          <span>Release tags</span>
          <div>
            <StagesEditor key={`${name}-stages`} value={line.releaseStages} onChange={(releaseStages) => props.onChange({ releaseStages })} />
            <small className="muted">
              {line.releaseStages ? "This line's repos use these (unless a repo has its own)." : `Empty: as in general${form.releaseStages?.length ? ` (${formatStages(form.releaseStages).replace(/\n/g, ", ")})` : " (off)"}.`}
            </small>
          </div>
        </label>
      </div>

      <h3>Jira</h3>
      <div className="segmented small">
        {(
          [
            ["general", "As in general"],
            ["own", "Its own Jira"],
            ["off", "No Jira"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            className={jiraMode === mode ? "active" : ""}
            onClick={() => props.onChange({ jira: mode === "general" ? undefined : mode === "off" ? { level: "off" } : { level: "optional", ...(jira?.level !== "off" ? jira : {}) } })}
          >
            {label}
          </button>
        ))}
      </div>
      {jiraMode === "general" && <p className="muted small">Features on this line use {general}.</p>}
      {jiraMode === "own" && jira && (
        <>
          <div className="levels">
            {JIRA_LEVELS.filter((l) => l.value !== "off").map((l) => (
              <label key={l.value} className={`level${jira.level === l.value ? " active" : ""}`}>
                <input type="radio" name={`jira-level-${name}`} checked={jira.level === l.value} onChange={() => setJira({ level: l.value })} />
                <b>{l.label}</b>
                <span className="muted">{l.hint}</span>
              </label>
            ))}
          </div>
          <div className="form">
            <label>
              <span>Site</span>
              <input value={jira.site ?? ""} placeholder="https://customer.atlassian.net" onChange={(e) => setJira({ site: e.target.value })} />
            </label>
            <label>
              <span>Email</span>
              <input value={jira.email ?? ""} placeholder="you@customer.com" onChange={(e) => setJira({ email: e.target.value })} />
            </label>
            <label>
              <span>API token</span>
              <input
                type="password"
                value={jira.token ?? ""}
                placeholder={props.savedToken ? "•••••••• (saved; type to replace)" : "paste an API token for this site"}
                onChange={(e) => setJira({ token: e.target.value || undefined })}
              />
            </label>
            <label>
              <span>Project for new tasks</span>
              <input value={jira.project ?? ""} placeholder="e.g. ABC" onChange={(e) => setJira({ project: e.target.value.toUpperCase() })} />
            </label>
            <div className="row">
              <button
                onClick={async () => {
                  if (!(await props.save())) return;
                  setTest("Testing…");
                  const r = await api.jiraTest(name);
                  setTest(r.ok ? `✓ Connected as ${r.value}` : `✗ ${r.error}`);
                }}
              >
                Save and test the connection
              </button>
              {test && <span className={test.startsWith("✓") ? "add" : test.startsWith("✗") ? "del" : "muted"}>{test}</span>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
