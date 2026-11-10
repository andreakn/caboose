import { useCallback, useEffect, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import {
  checksSummary,
  createPrMessage,
  fixCiMessage,
  type GitHubStatus,
  mergeConflictsMessage,
  type MergeMethod,
  resolveConflictsMessage,
} from "../../shared/github.ts";
import { copilotPending, copilotWanted, type Feature, type FeatureRepo, type JiraLevel, type RepoOverview, type StageRelease } from "../../shared/types.ts";
import { activeChat } from "./Chat.tsx";
import { askText } from "./Dialog.tsx";
import { MenuButton, type MenuItem, useApps } from "./Menu.tsx";
import { HealthDot, JiraStatusChip, PrChip, PrDetailsPanel } from "./Overview.tsx";
import { StatusChip } from "./Plan.tsx";
import { repoLabel } from "./labels.ts";
import { jiraBeforePrs } from "./jiraCheck.ts";
import { RunningChips } from "./Running.tsx";
import { stageEmoji } from "../../shared/stages.ts";
import { TagReleaseDialog } from "./TagRelease.tsx";

const api = window.caboose;

/** A repo's GitHub status, refreshed every 15 s, on focus and when a chat turn ends. */
export function useGitHub(feature: Feature, repo: string, chats: Chat[]) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (feature.archived || document.hidden) return;
    const r = await api.githubStatus(feature.id, repo);
    if (r.ok) {
      setStatus(r.value);
      setError(null);
    } else setError(r.error);
  }, [feature.id, repo, feature.archived]);

  useEffect(() => {
    setStatus(null);
    void refresh();
    const timer = setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const chatIds = chats.map((c) => c.id).join();
  useEffect(
    () =>
      api.onChatEvent((chatId, e) => {
        if (e.t === "result" && chatIds.includes(chatId)) void refresh();
      }),
    [chatIds, refresh],
  );

  return { status, error, refresh };
}

/**
 * One repo of a feature, on one line: health dot, name, reported status, PR
 * (checks, open comments), Jira, a short local state, the one action that
 * matters now, and a menu with the rest. Click the line for the details.
 */
export function RepoRow(props: {
  feature: Feature;
  repo: FeatureRepo;
  chats: Chat[];
  jiraLevel: JiraLevel;
  /** The repo's subtask, else the feature's task. */
  jiraKey?: string;
  subtask?: string;
  hasTask: boolean;
  jiraSite?: string;
  prInstructions?: string;
  /** From the feature overview: PR details, Jira status, what the agent reported. */
  ov?: RepoOverview;
  hasChat?: boolean;
  onChat?: () => void;
  onJiraChanged: () => void;
  onAskedAgent: () => void;
  /** Opens the repo's own view (its files, changes, chat, programs). */
  onOpen?: () => void;
  /** Shown in the repo's own tab row: one line, no card, details behind ⓘ. */
  inline?: boolean;
  onChanged: () => void;
}) {
  const { feature, repo, jiraKey, ov } = props;
  const { status, error, refresh } = useGitHub(feature, repo.name, props.chats);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [tagging, setTagging] = useState(false);
  const apps = useApps();

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) {
    setBusy(label);
    const r = await fn();
    setBusy(null);
    if (r && !r.ok) alert(r.error);
    refresh();
    props.onJiraChanged();
    props.onChanged();
  }

  async function askAgent(message: string) {
    // The repo's own chat if it has one, else the feature's open chat.
    const chat = props.chats.filter((c) => c.repo === repo.name).at(-1) ?? activeChat(feature, props.chats);
    if (!chat) return;
    const r = await api.send(chat.id, message);
    if (!r.ok) return alert(r.error);
    props.onAskedAgent();
  }

  async function createPr(draft: boolean) {
    // No Jira issue for the branch: offer to create the feature's task and this repo's subtask first.
    const fresh = await jiraBeforePrs(feature, [repo], props.jiraLevel, Boolean(props.jiraSite));
    if (!fresh) return;
    props.onJiraChanged();
    const now = (await api.getState()).features.find((x) => x.id === feature.id)?.repos.find((r) => r.name === repo.name) ?? repo;
    void askAgent(createPrMessage(now.name, now.branch, now.baseRef, draft, fresh.subtasks[repo.name] ?? fresh.task, props.prInstructions));
  }

  function merge(method: MergeMethod) {
    if (!pr) return;
    const c = ghPr ? checksSummary(ghPr.checks) : { failed: 0, pending: 0 };
    const warn = c.failed ? `\n\n${c.failed} check(s) are failing.` : c.pending ? "\n\nSome checks are still running." : "";
    if (confirm(`Merge ${repo.name} PR #${pr.number} into ${pr.base ?? "its base"} (${method})?${warn}`)) {
      localStorage.setItem("caboose-merge-method", method);
      void act("Merging…", () => api.merge(feature.id, repo.name, method));
    }
  }

  /** Pull or merge the base; on conflicts nothing changed, and the agent can be asked to do it. */
  async function mergeLocally(what: "pull" | "base") {
    const from = what === "pull" ? (b?.upstream ?? "the upstream") : repo.baseRef;
    setBusy(what === "pull" ? "Pulling…" : `Merging ${base}…`);
    const r = await (what === "pull" ? api.pull(feature.id, repo.name) : api.mergeBase(feature.id, repo.name));
    setBusy(null);
    refresh();
    props.onChanged();
    if (!r.ok) return alert(r.error);
    const files = r.value.conflicts;
    if (files.length && confirm(`Merging ${from} conflicts in ${files.length} file(s), so nothing was changed:\n${files.join("\n")}\n\nAsk the agent to merge it and resolve the conflicts?`)) {
      void askAgent(mergeConflictsMessage(repo.name, from, files));
    }
  }

  const b = status?.branch;
  const base = repo.baseRef.replace(/^origin\//, "");
  const ghPr = status?.available ? status.pr : null;
  // PR details from the overview when there, else the per-repo status.
  const pr = ov?.pr ?? (ghPr ? { ...ghPr, base: ghPr.baseRefName } : null);
  const live = Boolean(pr && (pr.state === "OPEN" || pr.state === "DRAFT"));
  const isDraft = pr ? pr.state === "DRAFT" || ("isDraft" in pr && pr.isDraft) : false;
  const failing = ov?.pr ? ov.pr.checks.state === "failing" : ghPr ? checksSummary(ghPr.checks).failed > 0 : false;
  const conflicts = pr?.mergeable === "CONFLICTING";
  // The failing checks, from whichever PR data is there.
  const failedChecks = ov?.pr ? ov.pr.checks.failed : ghPr ? ghPr.checks.filter((c) => c.state === "failure").map((c) => ({ name: c.name, ...(c.url ? { url: c.url } : {}) })) : [];
  const canPush = Boolean(b?.upstream && b.ahead > 0);
  // GitHub says CLEAN (or HAS_HOOKS) once required checks and reviews are done and nothing conflicts.
  const mergeState = ov?.pr?.mergeState;
  const cleared = mergeState === "CLEAN" || mergeState === "HAS_HOOKS";
  const notYet: Record<string, string> = {
    BLOCKED: "GitHub would not merge yet: a required review or check is missing.",
    BEHIND: `The branch must be brought up to date with ${repo.baseRef.replace(/^origin\//, "")} first.`,
    UNSTABLE: "Checks that are not required are failing; it can still be merged.",
    DRAFT: "Still a draft.",
    UNKNOWN: "GitHub is still working out whether it can be merged.",
  };
  const method = (localStorage.getItem("caboose-merge-method") as MergeMethod) || "squash";

  const local = b
    ? [
        b.uncommitted > 0 && `${b.uncommitted} uncommitted`,
        b.upstream ? b.ahead > 0 && `${b.ahead} to push` : b.ahead > 0 ? `${b.ahead} unpushed` : "",
        b.behind > 0 && `${b.behind} to pull`,
        // Once merged, being behind the base says nothing: the change is in it.
        b.behindBase > 0 && pr?.state !== "MERGED" && `${b.behindBase} behind ${base}`,
      ].filter(Boolean)
    : [];

  // The one action that matters now.
  const primary: { label: string; run: () => void; ready?: boolean; title?: string } | null = feature.archived
    ? null
    : b && b.behind > 0
      ? { label: "Pull", run: () => void mergeLocally("pull") }
      : status?.available && !live && pr?.state !== "MERGED"
      ? { label: "Create PR", run: () => createPr(false) }
      : live && conflicts
          ? { label: "Resolve conflicts", run: () => ghPr && void askAgent(resolveConflictsMessage(repo.name, ghPr)) }
          : canPush
            ? { label: "Push", run: () => void act("Pushing…", () => api.push(feature.id, repo.name)) }
            : live && !isDraft && !conflicts
              ? {
                  label: cleared ? "✓ Merge" : mergeState === "BLOCKED" ? "Merge (blocked)" : "Merge",
                  run: () => merge(method),
                  ready: cleared,
                  title: cleared ? `Cleared for merging: checks and reviews are done (${method})` : (mergeState && notYet[mergeState]) || undefined,
                }
              : pr?.state === "MERGED" && ov?.strategy === "tag" && !ov.release?.[0]?.tags.length
                ? { label: "Tag release…", run: () => setTagging(true), title: "Merged, but no release has it yet: tag the next version on the base branch" }
                : b && b.behindBase > 0 && pr?.state !== "MERGED"
                  ? { label: `Merge ${base}`, run: () => void mergeLocally("base") }
                  : null;

  const items: MenuItem[] = feature.archived
    ? []
    : [
        ...(props.onChat ? [{ label: props.hasChat ? `${repo.name}'s chat` : "Break out a chat for this repo…", onClick: props.onChat }] : []),
        ...(status?.available && !live ? [{ label: "Create draft PR", onClick: () => createPr(true) }, { label: "Create PR", onClick: () => createPr(false) }] : []),
        ...(canPush ? [{ label: "Push", onClick: () => void act("Pushing…", () => api.push(feature.id, repo.name)) }] : []),
        ...(b && b.behind > 0 ? [{ label: `Pull ${b.behind} commit(s) from ${b.upstream}`, onClick: () => void mergeLocally("pull") }] : []),
        ...(b && b.behindBase > 0 && pr?.state !== "MERGED" ? [{ label: `Merge ${repo.baseRef} into this branch (${b.behindBase} new)`, onClick: () => void mergeLocally("base") }] : []),
        ...(live && pr && failing ? [{ label: "Fix CI (ask the agent)", onClick: () => void askAgent(fixCiMessage([{ repo: repo.name, pr: pr.number, checks: failedChecks }])) }] : []),
        ...(live && ghPr && conflicts ? [{ label: "Ask the agent to resolve conflicts", onClick: () => void askAgent(resolveConflictsMessage(repo.name, ghPr)) }] : []),
        ...(live && !isDraft && !conflicts
          ? (["squash", "merge", "rebase"] as MergeMethod[]).map((m) => ({ label: `Merge (${m === "merge" ? "merge commit" : m})`, onClick: () => merge(m) }))
          : []),
        ...(pr ? [{ label: `Open PR #${pr.number} on GitHub`, onClick: () => void api.openUrl(pr.url) }] : []),
        ...(ov?.strategy === "tag" ? [{ label: "Tag a release…", onClick: () => setTagging(true) }] : []),
        "separator" as const,
        // In a repo's own tab the open-in button sits in the tab row instead.
        ...(props.inline
          ? []
          : [
              ...apps.map((a) => ({ label: `Open in ${a.label}`, onClick: () => void api.openIn(a.id, repo.path).then((r) => !r.ok && alert(r.error)) })),
              "separator" as const,
            ]),
        ...(b && !b.upstream ? [{ label: "Rename branch…", onClick: () => void renameBranch(feature, repo, refresh) }] : []),
        ...(props.jiraLevel !== "off"
          ? props.subtask
            ? [{ label: `Unlink Jira ${props.subtask}`, onClick: () => confirm(`Unlink ${props.subtask}?`) && void act("Saving…", () => api.setRepoSubtask(feature.id, repo.name, null)) }]
            : [
                { label: "Link a Jira subtask…", onClick: () => void linkSubtask(feature, repo, act) },
                ...(props.hasTask
                  ? [{ label: "Create the Jira subtask", onClick: () => void act("Creating subtask…", () => api.createSubtask(feature.id, repo.name)) }]
                  : []),
              ]
          : []),
      ];

  const chips = (
    <>
      {ov?.reported?.status && (
        <span title={`${ov.reported.at}: ${ov.reported.text}`}>
          <StatusChip status={ov.reported.status} />
        </span>
      )}
      {ov?.pr ? <PrChip pr={ov.pr} /> : ghPr && <PrLink pr={ghPr} />}
      {live && ov?.pr && awaitingApproval(ov.pr) && (
        <span
          className="chip awaiting-approval"
          title={`GitHub will not merge this yet: it needs an approving review${ov.pr.requested.length ? ` (asked: ${ov.pr.requested.join(", ")})` : ""}.`}
        >
          ⏳ waiting for approval
        </span>
      )}
      {live && ov?.pr && copilotPending(ov.pr) ? (
        <span className="chip copilot-pending" title="Copilot has been asked to review and has not yet">
          Copilot reviewing…
        </span>
      ) : (
        // Only while the PR is open: after a merge (or a close) the review has done its job.
        live &&
        ov?.pr?.copilot && (
          <span
            className={`chip copilot-verdict v-${ov.pr.copilot.verdict}${ov.pr.copilot.current ? "" : " outdated"}`}
            title={`Copilot's review, ${ov.pr.copilot.at.slice(0, 16).replace("T", " ")}: ${ov.pr.copilot.summary}${ov.pr.copilot.current ? "" : "\nOf an older commit: there are newer commits it has not seen."}`}
          >
            Copilot {{ approve: "🟢", comments: "🟡", changes: "🔴", reviewed: "💬" }[ov.pr.copilot.verdict]} {ov.pr.copilot.summary}
            {ov.pr.copilot.current ? "" : " (older commit)"}
          </span>
        )
      )}
      {ov?.release && (
        <ReleaseChips
          release={ov.release}
          hide={otherComponents(ov)}
          onApprove={
            feature.archived
              ? undefined
              : (tags) => void api.openApproval(feature.id, repo.name, tags).then((r) => !r.ok && alert(r.error))
          }
        />
      )}
      {ov?.running && <RunningChips feature={feature} ov={ov} onChanged={props.onChanged} />}
      {ov?.jira ? <JiraStatusChip j={ov.jira} site={props.jiraSite} /> : props.subtask && <JiraStatusChip j={{ key: props.subtask }} site={props.jiraSite} />}
    </>
  );
  const actions = (
    <span className="row" onClick={(e) => e.stopPropagation()}>
      {live && failing && pr && !feature.archived && (
        <button
          className="fix-ci"
          disabled={!!busy}
          title={`CI fails on PR #${pr.number}: ask ${props.chats.some((c) => c.repo === repo.name) ? `${repo.name}'s chat` : "the feature's chat"} to find out why and fix it`}
          onClick={() => void askAgent(fixCiMessage([{ repo: repo.name, pr: pr.number, checks: failedChecks }]))}
        >
          Fix CI
        </button>
      )}
      {live && ov?.pr && copilotWanted(ov.pr) && !feature.archived && (
        <button
          className="copilot-review"
          disabled={!!busy}
          title={`Ask GitHub Copilot to review PR #${ov.pr.number} (again, if it already has: it reviews what is new)`}
          onClick={() => void act("Asking Copilot…", () => requestCopilot(feature.id, repo.name))}
        >
          {ov.pr.copilot ? "Copilot review again" : "Copilot review"}
        </button>
      )}
      {primary && (
        <button className={primary.ready ? "primary merge-ready" : "primary"} onClick={primary.run} disabled={!!busy} title={primary.title}>
          {primary.label}
        </button>
      )}
      {items.length > 0 && <MenuButton label="⋯" title="More" align="right" items={items} />}
    </span>
  );
  const details = (
    <div className="repo-details">
      <div>
        <span className="muted">branch</span> <code>{repo.branch}</code> <span className="muted">from</span> <code>{repo.baseRef}</code>
        {b && (
          <span className="muted">
            {" "}
            · {b.upstream ? `pushed to ${b.upstream}` : "not pushed"}
            {b.ahead ? ` · ${b.ahead} commit(s) ahead` : ""}
            {b.uncommitted ? ` · ${b.uncommitted} uncommitted` : ""}
            {b.behind ? ` · ${b.behind} to pull` : ""}
            {b.behindBase && pr?.state !== "MERGED" ? ` · ${b.behindBase} behind ${repo.baseRef}` : ""}
          </span>
        )}
      </div>
      {ov?.reported && (
        <div>
          <span className="muted">last report ({ov.reported.at})</span> <StatusChip status={ov.reported.status!} /> {ov.reported.text}
        </div>
      )}
      {ov?.jira && "status" in ov.jira && (
        <div>
          <span className="muted">Jira</span> {ov.jira.key}: {ov.jira.summary} · {ov.jira.status}
          {ov.jira.assignee ? ` · ${ov.jira.assignee}` : ""}
        </div>
      )}
      {status && !status.available && <div className="muted">{status.reason}</div>}
      {ov?.pr && (
        <div>
          <a href="#" onClick={(e) => (e.preventDefault(), api.openUrl(ov.pr!.url))}>
            PR #{ov.pr.number}: {ov.pr.title}
          </a>
          <PrDetailsPanel pr={ov.pr} />
        </div>
      )}
    </div>
  );

  const tagDialog = tagging && (
    <TagReleaseDialog
      f={feature}
      repo={repo.name}
      ov={ov}
      onClose={() => setTagging(false)}
      onDone={() => {
        refresh();
        props.onChanged();
      }}
    />
  );

  // In the repo's own tab row: no card and no name (the tab says it), details behind ⓘ.
  if (props.inline) {
    return (
      <span className="repo-inline">
        {tagDialog}
        {chips}
        <span className="muted repo-local one-line">{busy ?? (error ? "status failed" : local.join(" · "))}</span>
        {actions}
        <span className="info-wrap">
          <button className={`icon${open ? " active" : ""}`} title="Branch, last report, PR details" onClick={() => setOpen(!open)}>
            ⓘ
          </button>
          {open && (
            <>
              <div className="popover-backdrop" onClick={() => setOpen(false)} />
              <div className="popover repo-popover">{details}</div>
            </>
          )}
        </span>
      </span>
    );
  }

  return (
    <div className={`repo-row${open ? " open" : ""}`}>
      {tagDialog}
      <div className="repo-line" onClick={() => setOpen(!open)}>
        <span className="twisty">{open ? "▾" : "▸"}</span>
        {ov ? <HealthDot r={ov} /> : <span className={`dot setup-${repo.setup}`} title={`Setup: ${repo.setup}`} />}
        {props.onOpen ? (
          <button
            className="repo-name-cell repo-open"
            title={`Open ${repo.name}: files, changes, its chat and programs`}
            onClick={(e) => {
              e.stopPropagation();
              props.onOpen!();
            }}
          >
            {repoLabel(repo.name)}
          </button>
        ) : (
          <b className="repo-name-cell" title={repo.name}>{repoLabel(repo.name)}</b>
        )}
        {chips}
        <span className="muted repo-local one-line">{busy ?? (error ? "status failed" : local.join(" · "))}</span>
        {actions}
      </div>
      {open && details}
    </div>
  );
}

/** "🏷 shop_v1.114 · test ✓ · prod –": the first release carrying the merged PR, and which later stages have it. */
/**
 * GitHub blocks the merge and what is missing is an approval: blocked, not
 * failing its checks and with no changes requested (those show themselves),
 * and nobody has approved yet.
 */
function awaitingApproval(pr: { mergeState: string; checks: { state: string }; changesRequested: string[]; approvals: string[]; reviewDecision: string | null }): boolean {
  return pr.mergeState === "BLOCKED" && pr.checks.state !== "failing" && pr.checks.state !== "pending" && !pr.changesRequested.length && (pr.reviewDecision === "REVIEW_REQUIRED" || !pr.approvals.length);
}

/** Components of the repo this feature does not touch (their tags are not shown). */
function otherComponents(ov: RepoOverview): string[] {
  if (!ov.components?.length) return [];
  const all = new Set((ov.running?.versions ?? []).map((v) => v.component).filter(Boolean));
  return [...all].filter((c) => !ov.components!.includes(c));
}

function ReleaseChips({ release: all, hide = [], onApprove }: { release: StageRelease[]; hide?: string[]; onApprove?: (tags: string[]) => void }) {
  // Tags of components this feature does not touch (orders_v1.2 when only stock matters) are left out.
  const other = (tag: string) => hide.some((c) => tag.startsWith(`${c}_`) || tag.startsWith(`${c}-`));
  const release = all.map((r) => ({ ...r, tags: r.tags.filter((t) => !other(t)) }));
  const [first, ...later] = release;
  if (!first) return null;
  const title = release.map((r) => `${r.stage}: ${r.tags.length ? r.tags.join(", ") : "not yet"}`).join("\n");
  return (
    <span className="release-chips" title={title}>
      <span className={`chip release${first.tags.length ? "" : " pending"}`}>🏷 {first.tags.length ? first.tags.join(", ") : `no ${first.stage} yet`}</span>
      {later.map((r, i) => {
        // A prod stage the release has not reached yet, while the stage before it has: approving is a click away.
        const before = i === 0 ? first : later[i - 1];
        const approvable = onApprove && !r.tags.length && before.tags.length > 0 && stageEmoji(r.stage) === "🚀";
        return approvable ? (
          <button
            key={r.stage}
            className="chip stage pending approvable"
            title={`Not in ${r.stage} yet: open the deploy waiting for approval in GitHub Actions`}
            onClick={(e) => {
              e.stopPropagation();
              onApprove(release.flatMap((x) => x.tags));
            }}
          >
            {r.stage} – approve ↗
          </button>
        ) : (
          <span key={r.stage} className={`chip stage${r.tags.length ? " ok" : " pending"}`}>
            {r.stage} {r.tags.length ? "✓" : "–"}
          </span>
        );
      })}
    </span>
  );
}

function PrLink({ pr }: { pr: { number: number; url: string; title: string } }) {
  return (
    <a
      className="pr-chip"
      href="#"
      title={pr.title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void api.openUrl(pr.url);
      }}
    >
      #{pr.number}
    </a>
  );
}

/** Asks Copilot to review; says why not when it did not. */
export async function requestCopilot(featureId: string, repo?: string): Promise<{ ok: boolean; error?: string }> {
  const r = await api.requestCopilotReview(featureId, repo);
  if (!r.ok) return r;
  const { requested, skipped, failed } = r.value;
  if (failed.length) return { ok: false, error: failed.map((f) => `${f.repo}: ${f.error}`).join("\n") };
  if (!requested.length && skipped.length && repo) return { ok: false, error: `Not asked: ${skipped.map((s) => s.why).join(", ")}.` };
  return { ok: true };
}

async function renameBranch(feature: Feature, repo: FeatureRepo, done: () => void) {
  const name = await askText({ title: `Rename ${repo.name}'s branch`, value: repo.branch, ok: "Rename" });
  if (!name || name === repo.branch) return;
  const r = await api.renameBranch(feature.id, repo.name, name);
  if (!r.ok) alert(r.error);
  done();
}

async function linkSubtask(feature: Feature, repo: FeatureRepo, act: (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => Promise<void>) {
  const key = await askText({ title: `Link a Jira subtask to ${repo.name}`, label: "Its key or URL", placeholder: "e.g. ABC-1234", ok: "Link" });
  if (key) await act("Saving…", () => api.setRepoSubtask(feature.id, repo.name, key));
}

/** Branch name with an edit button while it is unpushed. */
function BranchName(props: { feature: Feature; repo: FeatureRepo; canRename: boolean; onRenamed: () => void }) {
  const { feature, repo } = props;
  return (
    <span className="branch">
      <code>{repo.branch}</code>
      {props.canRename && !feature.archived && (
        <button
          className="link"
          title="Rename branch"
          onClick={async () => {
            const name = await askText({ title: `Rename ${repo.name}'s branch`, value: repo.branch, ok: "Rename" });
            if (!name || name === repo.branch) return;
            const r = await api.renameBranch(feature.id, repo.name, name);
            if (!r.ok) alert(r.error);
            props.onRenamed();
          }}
        >
          ✎
        </button>
      )}
    </span>
  );
}

/** A Jira key as a link, with set/clear (and create, where offered). */
export function JiraChip(props: {
  label: string;
  jiraKey?: string;
  site?: string;
  onSet: (key: string | null) => void;
  onCreate?: () => void;
}) {
  const { jiraKey, site } = props;
  if (jiraKey) {
    return (
      <span className="jira-chip">
        <a
          href="#"
          title={`Open ${jiraKey} in Jira`}
          onClick={(e) => {
            e.preventDefault();
            if (site) void api.openUrl(`${site.replace(/\/+$/, "")}/browse/${jiraKey}`);
          }}
        >
          {jiraKey}
        </a>
        <button className="link" title={`Unlink this ${/jira/i.test(props.label) ? props.label : `Jira ${props.label}`}`} onClick={() => confirm(`Unlink ${jiraKey}?`) && props.onSet(null)}>
          ×
        </button>
      </span>
    );
  }
  return (
    <span className="jira-chip empty">
      <button
        className="link"
        onClick={async () => {
          const key = await askText({ title: `Link a ${/jira/i.test(props.label) ? props.label : `Jira ${props.label}`}`, label: "Its key or URL", placeholder: "e.g. ABC-1234", ok: "Link" });
          if (key) props.onSet(key);
        }}
      >
        + {props.label}
      </button>
      {props.onCreate && (
        <button className="link" onClick={props.onCreate}>
          create
        </button>
      )}
    </span>
  );
}
