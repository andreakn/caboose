import { useCallback, useEffect, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import type { PrDetails } from "../../shared/github.ts";
import type { Feature, FeatureOverview, JiraStatus, RepoOverview } from "../../shared/types.ts";
import { activityOf, useActivityVersion } from "./activity.ts";
import { StatusChip } from "./Plan.tsx";
import { repoLabel } from "./labels.ts";
import { stationLabel } from "../../shared/stations.ts";

const api = window.caboose;

/** A feature's overview, refreshed every 30 s while shown (GitHub/Jira answers are cached 60 s in main). */
export function useOverview(f: Feature | undefined, active = true) {
  const [ov, setOv] = useState<FeatureOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const id = f?.id;
  const load = useCallback(
    async (fresh = false) => {
      if (!id) return;
      setLoading(true);
      try {
        setOv(await api.overview(id, fresh));
      } finally {
        setLoading(false);
      }
    },
    [id],
  );
  useEffect(() => {
    setOv(null);
    void load();
  }, [id]);
  useEffect(() => {
    if (!active || !id) return;
    const t = setInterval(() => !document.hidden && void load(), 30_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, id, load]);
  return { ov, loading, refresh: () => load(true), reload: () => load(false) };
}

export type Health = "attention" | "busy" | "good" | "merged" | "done" | "idle";

/** One colour per repo, most urgent first: needs you / failing / conflicts → attention; working / pending → busy; merged → done. */
export function repoHealth(r: RepoOverview): { health: Health; why: string } {
  const pr = r.pr;
  const s = r.reported?.status;
  if (s === "needs-input" || s === "blocked") return { health: "attention", why: `${s}: ${r.reported!.text.split("\n")[0]}` };
  if (pr && (pr.state === "OPEN" || pr.state === "DRAFT")) {
    if (pr.checks.state === "failing") return { health: "attention", why: `${pr.checks.failed.length} failing check(s)` };
    if (pr.mergeable === "CONFLICTING") return { health: "attention", why: "merge conflicts" };
    if (pr.reviewDecision === "CHANGES_REQUESTED") return { health: "attention", why: "changes requested" };
    if (pr.threads.length) return { health: "attention", why: `${pr.threads.length} unresolved review comment(s)` };
    if (pr.checks.state === "pending") return { health: "busy", why: "checks running" };
    return { health: "good", why: pr.reviewDecision === "APPROVED" ? "approved" : "PR open" };
  }
  if (pr?.state === "MERGED") return { health: "merged", why: "merged" };
  if (s === "done") return { health: "done", why: "done" };
  if (s === "working") return { health: "busy", why: "working" };
  if (s === "ready" || s === "in-review") return { health: "good", why: s };
  return { health: "idle", why: s ?? "no report yet" };
}

/** Every repo of the feature has a merged PR: the feature is finished and can be archived. */
export function allMerged(ov: FeatureOverview | null | undefined): boolean {
  return Boolean(ov && ov.repos.length > 0 && ov.repos.every((r) => r.pr?.state === "MERGED"));
}

export function HealthDot({ r }: { r: RepoOverview }) {
  const { health, why } = repoHealth(r);
  return <span className={`hdot h-${health}`} title={`${repoLabel(r.name)}: ${why}`} />;
}

/** "#12 ✓ 💬2" — the PR's number with its checks and open threads; click opens it on GitHub. */
export function PrChip({ pr }: { pr: PrDetails }) {
  const icon = { passing: "✓", failing: "✗", pending: "●", none: "" }[pr.checks.state];
  return (
    <a
      className={`pr-chip pr-${pr.state.toLowerCase()} checks-${pr.checks.state}`}
      href="#"
      title={`${pr.title}\n${pr.state.toLowerCase()} · checks ${pr.checks.state}${pr.reviewDecision ? ` · ${pr.reviewDecision.toLowerCase().replace("_", " ")}` : ""}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void api.openUrl(pr.url);
      }}
    >
      #{pr.number}
      {pr.state === "DRAFT" && " draft"}
      {pr.state === "MERGED" && " merged"}
      {pr.state === "CLOSED" && " closed"}
      {icon && <span className="pr-checks">{icon}</span>}
      {pr.threads.length > 0 && <span className="pr-threads">💬{pr.threads.length}</span>}
    </a>
  );
}

export function JiraStatusChip({ j, site }: { j: JiraStatus | { key: string }; site?: string }) {
  const s = "status" in j ? j : null;
  return (
    <a
      className={`jira-status jc-${s?.category ?? "unknown"}`}
      href="#"
      title={s ? `${s.summary}\n${s.status}${s.assignee ? ` · ${s.assignee}` : ""}` : j.key}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = s?.url ?? (site ? `${site.replace(/\/+$/, "")}/browse/${j.key}` : null);
        if (url) void api.openUrl(url);
      }}
    >
      {j.key}
      {s && <span className="jira-state">{s.status}</span>}
    </a>
  );
}

// ---- Pull requests tab -----------------------------------------------------

/** The feature's PRs in numbers: open, merged, failing builds, comments, approvals… (the Repos tab's header). */
export function PrTiles({ ov, loading, refresh }: { ov: FeatureOverview | null; loading: boolean; refresh: () => void }) {
  if (!ov) return <div className="muted small">Loading…</div>;
  const prs = ov.repos.filter((r) => r.pr).map((r) => r.pr!);
  const live = prs.filter((p) => p.state === "OPEN" || p.state === "DRAFT");
  const without = ov.repos.filter((r) => r.pr === null);
  const tiles: [string, number, string?][] = [
    ["open", prs.filter((p) => p.state === "OPEN").length],
    ["draft", prs.filter((p) => p.state === "DRAFT").length],
    ["merged", prs.filter((p) => p.state === "MERGED").length, "merged"],
    ["failing builds", live.filter((p) => p.checks.state === "failing").length, "bad"],
    ["unresolved comments", live.reduce((n, p) => n + p.threads.length, 0), "bad"],
    ["approved", live.filter((p) => p.reviewDecision === "APPROVED").length, "good"],
    ["changes requested", live.filter((p) => p.reviewDecision === "CHANGES_REQUESTED").length, "bad"],
    ["repos without a PR", without.length],
  ];
  return (
    <>
      <div className="tiles">
        {tiles.map(([label, n, tone]) => (
          <div key={label} className={`tile${n && tone ? ` ${tone}` : ""}`}>
            <b>{n}</b>
            <span>{label}</span>
          </div>
        ))}
        <span className="spacer" />
        <button onClick={refresh} disabled={loading} title="Ask GitHub and Jira again (answers are cached for a minute)">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {ov.errors.map((e) => (
        <div key={e} className="banner error">
          {e}
        </div>
      ))}
    </>
  );
}

export function PrDetailsPanel({ pr }: { pr: PrDetails }) {
  return (
    <div className="pr-details">
      <div className="muted">
        <code>{pr.head}</code> → <code>{pr.base}</code> · {pr.changedFiles} file(s) · merge state {pr.mergeState.toLowerCase()}
        {pr.approvals.length > 0 && ` · approved by ${pr.approvals.join(", ")}`}
        {pr.changesRequested.length > 0 && ` · changes requested by ${pr.changesRequested.join(", ")}`}
        {pr.requested.length > 0 && ` · waiting for ${pr.requested.join(", ")}`}
      </div>
      {pr.checks.failed.length > 0 && (
        <div>
          <b className="del">Failing checks</b>
          {pr.checks.failed.map((c) => (
            <div key={c.name}>
              ✗{" "}
              {c.url ? (
                <a href="#" onClick={(e) => (e.preventDefault(), api.openUrl(c.url!))}>
                  {c.name}
                </a>
              ) : (
                c.name
              )}
            </div>
          ))}
        </div>
      )}
      {pr.threads.length > 0 && (
        <div>
          <b>Unresolved comments</b>
          {pr.threads.map((t, i) => (
            <div key={i} className="thread">
              <a href="#" onClick={(e) => (e.preventDefault(), api.openUrl(t.url))}>
                {t.path}
                {t.line ? `:${t.line}` : ""}
              </a>{" "}
              <span className="muted">
                {t.author}
                {t.outdated ? " · outdated" : ""}
                {t.replies ? ` · ${t.replies} repl${t.replies === 1 ? "y" : "ies"}` : ""}
              </span>
              <div className="one-line">{t.body.split("\n")[0]}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Board -----------------------------------------------------------------

/** Every live feature on one screen: a dot per repo, badges only for what needs you. */
export function Board(props: { features: Feature[]; chats: Chat[]; onOpen: (id: string) => void; onNew: () => void }) {
  useActivityVersion();
  const live = props.features.filter((f) => !f.archived);
  return (
    <div className="settings board">
      <header className="ws-header">
        <h1>Board</h1>
        <button className="primary" onClick={props.onNew}>
          + New feature
        </button>
      </header>
      {live.length === 0 && <p className="muted">No features yet.</p>}
      <div className="board-rows">
        {live.map((f) => (
          <BoardRow key={f.id} f={f} chats={props.chats.filter((c) => c.featureId === f.id)} onOpen={() => props.onOpen(f.id)} />
        ))}
      </div>
    </div>
  );
}

function BoardRow({ f, chats, onOpen }: { f: Feature; chats: Chat[]; onOpen: () => void }) {
  const { ov } = useOverview(f);
  const [open, setOpen] = useState(false);
  const waiting = chats.filter((c) => activityOf([c.id]).waiting > 0).length;
  const running = chats.some((c) => activityOf([c.id]).running);
  const attention = ov?.repos.filter((r) => repoHealth(r).health === "attention") ?? [];
  const p = ov?.progress;
  return (
    <div className="board-row">
      <div className="board-line" onClick={onOpen}>
        <button
          className="link twisty"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? "▾" : "▸"}
        </button>
        <span className="board-name">
          <b>{stationLabel(f.name)}</b>
          {f.title && <span className="muted"> {f.title}</span>}
        </span>
        <span className={`status-mini st-${f.status ?? "active"}`}>{f.status ?? "active"}</span>
        {allMerged(ov) && <span className="chip merged-chip" title="Every branch is merged: ready to archive">all merged</span>}
        {p && p.total > 0 && (
          <span className="mini-progress" title={`plan ${p.done}/${p.total}`}>
            <span style={{ width: `${(100 * p.done) / p.total}%` }} />
          </span>
        )}
        <span className="dots">{ov?.repos.map((r) => <HealthDot key={r.name} r={r} />) ?? f.repos.map((r) => <span key={r.name} className="hdot h-idle" />)}</span>
        <span className="spacer" />
        {running && <span className="dot act-running" title="An agent is working" />}
        {waiting > 0 && <span className="badge-attn">{waiting} asking</span>}
        {attention.length > 0 && (
          <span className="badge-attn" title={attention.map((r) => `${repoLabel(r.name)}: ${repoHealth(r).why}`).join("\n")}>
            {attention.length} need{attention.length === 1 ? "s" : ""} you
          </span>
        )}
        {ov?.task && <JiraStatusChip j={ov.task} />}
      </div>
      {open && ov && (
        <div className="board-repos">
          {ov.repos.map((r) => (
            <div key={r.name} className="board-repo">
              <HealthDot r={r} />
              <b>{repoLabel(r.name)}</b>
              {r.reported?.status && <StatusChip status={r.reported.status} />}
              {r.pr && <PrChip pr={r.pr} />}
              {r.jira && <JiraStatusChip j={r.jira} />}
              <span className="muted one-line">{repoHealth(r).why}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
