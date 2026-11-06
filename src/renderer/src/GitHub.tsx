import { useCallback, useEffect, useState } from "react";
import type { Chat } from "../../shared/chat.ts";
import {
  checksSummary,
  createPrMessage,
  fixChecksMessage,
  type GitHubStatus,
  type MergeMethod,
  resolveConflictsMessage,
} from "../../shared/github.ts";
import type { Feature, FeatureRepo, JiraLevel, LogEntry } from "../../shared/types.ts";
import { activeChat } from "./Chat.tsx";
import { askText } from "./Dialog.tsx";
import { OpenInMenu } from "./Menu.tsx";
import { StatusChip } from "./Plan.tsx";

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

/** One repo of a feature: branch, Jira subtask, local status and its PR. */
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
  /** What the repo's agent last reported. */
  reported?: LogEntry;
  hasChat?: boolean;
  onChat?: () => void;
  onJiraChanged: () => void;
  onAskedAgent: () => void;
}) {
  const { feature, repo, jiraKey } = props;
  const { status, error, refresh } = useGitHub(feature, repo.name, props.chats);
  const [busy, setBusy] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [method, setMethod] = useState<MergeMethod>(() => (localStorage.getItem("caboose-merge-method") as MergeMethod) || "squash");

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) {
    setBusy(label);
    const r = await fn();
    setBusy(null);
    if (r && !r.ok) alert(r.error);
    refresh();
    props.onJiraChanged();
  }

  async function askAgent(message: string) {
    const chat = activeChat(feature, props.chats);
    if (!chat) return;
    const r = await api.send(chat.id, message);
    if (!r.ok) return alert(r.error);
    props.onAskedAgent();
  }

  function createPr(draft: boolean) {
    if (props.jiraLevel === "expected" && !jiraKey && !confirm("This PR has no Jira issue. Create it anyway?")) return;
    void askAgent(createPrMessage(repo.name, repo.branch, repo.baseRef, draft, jiraKey, props.prInstructions));
  }

  const b = status?.branch;
  const local = b
    ? [
        b.uncommitted > 0 && `${b.uncommitted} uncommitted`,
        b.upstream ? b.ahead > 0 && `${b.ahead} to push` : b.ahead > 0 ? `${b.ahead} commit${b.ahead === 1 ? "" : "s"}, not pushed` : "not pushed",
        b.behind > 0 && `${b.behind} to pull`,
        b.behindBase > 0 && `${b.behindBase} behind ${repo.baseRef}`,
      ].filter(Boolean)
    : [];
  if (b && !local.length) local.push("up to date");

  const pr = status?.available ? status.pr : null;
  const checks = pr ? checksSummary(pr.checks) : null;
  const open = pr?.state === "OPEN";
  const jiraOn = props.jiraLevel !== "off";

  return (
    <div className="repo-row">
      <div className="repo-line">
        <span className={`dot setup-${repo.setup}`} title={`Setup: ${repo.setup}`} />
        <b className="repo-name-cell">{repo.name}</b>
        {props.reported?.status && (
          <span title={`${props.reported.at}: ${props.reported.text}`}>
            <StatusChip status={props.reported.status} />
          </span>
        )}
        <BranchName feature={feature} repo={repo} canRename={!!b && !b.upstream} onRenamed={refresh} />
        {jiraOn && (
          <JiraChip
            label="subtask"
            jiraKey={props.subtask}
            site={props.jiraSite}
            onSet={(key) => act("Saving…", () => api.setRepoSubtask(feature.id, repo.name, key))}
            onCreate={
              props.hasTask
                ? () =>
                    act("Creating subtask…", async () => {
                      const r = await api.createSubtask(feature.id, repo.name);
                      if (r.ok && r.value.renamed.length) alert(`Branch renamed to ${r.value.renamed[0].to}`);
                      return r;
                    })
                : undefined
            }
          />
        )}
        <span className="muted repo-local">{local.join(" · ")}</span>
        {busy && <span className="muted">{busy}</span>}
        <span className="spacer" />
        {!feature.archived && props.onChat && (
          <button onClick={props.onChat} title={props.hasChat ? `Open ${repo.name}'s chat` : `Break out a chat working in ${repo.name}/`}>
            {props.hasChat ? "⑂ chat" : "⑂ break out"}
          </button>
        )}
        {!feature.archived && <OpenInMenu path={repo.path} label="Open ▾" />}

        {status && !status.available && (
          <span className="muted" title={status.reason}>
            {status.reason}
          </span>
        )}
        {status?.available && (!pr || pr.state === "CLOSED") && (
          <>
            {pr && <PrLink pr={pr} />}
            <button className="primary" onClick={() => createPr(false)}>
              Create PR
            </button>
            <button onClick={() => createPr(true)}>Draft</button>
          </>
        )}
        {pr && open && checks && (
          <>
            <PrLink pr={pr} />
            {pr.isDraft && <span className="chip">Draft</span>}
            {pr.reviewDecision === "APPROVED" && <span className="chip ok">Approved</span>}
            {pr.reviewDecision === "CHANGES_REQUESTED" && <span className="chip bad">Changes requested</span>}
            {pr.checks.length > 0 && (
              <button className="link gh-checks" onClick={() => setShowChecks(!showChecks)}>
                {checks.failed > 0 && <span className="del">✗ {checks.failed}</span>}
                {checks.pending > 0 && <span className="pending">● {checks.pending}</span>}
                {checks.failed === 0 && checks.pending === 0 && <span className="add">✓ checks</span>}
              </button>
            )}
            {pr.mergeable === "CONFLICTING" && <span className="del">Conflicts</span>}
            {b?.upstream && b.ahead > 0 && <button onClick={() => act("Pushing…", () => api.push(feature.id, repo.name))}>Push</button>}
            {checks.failed > 0 && <button onClick={() => askAgent(fixChecksMessage(repo.name, pr))}>Fix checks</button>}
            {pr.mergeable === "CONFLICTING" && (
              <button onClick={() => askAgent(resolveConflictsMessage(repo.name, pr))}>Resolve conflicts</button>
            )}
            <select
              value={method}
              title="Merge method"
              onChange={(e) => {
                setMethod(e.target.value as MergeMethod);
                localStorage.setItem("caboose-merge-method", e.target.value);
              }}
            >
              <option value="squash">Squash</option>
              <option value="merge">Merge commit</option>
              <option value="rebase">Rebase</option>
            </select>
            <button
              className="primary"
              disabled={pr.isDraft || pr.mergeable === "CONFLICTING" || !!busy}
              title={pr.isDraft ? "Mark the PR ready for review first" : undefined}
              onClick={() => {
                const warn = checks.failed ? `\n\n${checks.failed} check(s) are failing.` : checks.pending ? "\n\nSome checks are still running." : "";
                if (confirm(`Merge ${repo.name} PR #${pr.number} into ${pr.baseRefName} (${method})?${warn}`)) {
                  void act("Merging…", () => api.merge(feature.id, repo.name, method));
                }
              }}
            >
              Merge
            </button>
          </>
        )}
        {pr?.state === "MERGED" && (
          <>
            <PrLink pr={pr} />
            <span className="chip ok">Merged</span>
          </>
        )}
        {error && (
          <span className="del" title={error}>
            status failed
          </span>
        )}
      </div>
      {showChecks && pr && (
        <ul className="gh-check-list">
          {pr.checks.map((c, i) => (
            <li key={i}>
              <span className={`check-${c.state}`}>{{ success: "✓", failure: "✗", pending: "●", skipped: "–" }[c.state]}</span>{" "}
              {c.url ? (
                <a href="#" onClick={(e) => (e.preventDefault(), api.openUrl(c.url!))}>
                  {c.name}
                </a>
              ) : (
                c.name
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrLink({ pr }: { pr: { number: number; url: string; title: string } }) {
  return (
    <a className="gh-pr" href="#" title={pr.title} onClick={(e) => (e.preventDefault(), api.openUrl(pr.url))}>
      PR #{pr.number} ↗
    </a>
  );
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
        <button className="link" title={`Unlink this ${props.label}`} onClick={() => confirm(`Unlink ${jiraKey}?`) && props.onSet(null)}>
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
          const key = await askText({ title: `Link a Jira ${props.label}`, label: "Its key or URL", placeholder: "e.g. NWP-1234", ok: "Link" });
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
