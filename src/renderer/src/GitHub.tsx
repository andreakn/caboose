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
import type { Workspace } from "../../shared/types.ts";
import { activeChat } from "./Chat.tsx";

const api = window.caboose;

/** The workspace's GitHub status, refreshed every 15 s, on focus and when a chat turn ends. */
export function useGitHub(ws: Workspace, chats: Chat[]) {
  const [status, setStatus] = useState<GitHubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (ws.archived || document.hidden) return;
    const r = await api.githubStatus(ws.id);
    if (r.ok) {
      setStatus(r.value);
      setError(null);
    } else setError(r.error);
  }, [ws.id, ws.archived]);

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

export function GitHubBar(props: {
  ws: Workspace;
  chats: Chat[];
  status: GitHubStatus | null;
  error: string | null;
  refresh: () => void;
  onAskedClaude: () => void;
  onArchive: () => void;
}) {
  const { ws, status } = props;
  const [busy, setBusy] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [method, setMethod] = useState<MergeMethod>(() => (localStorage.getItem("caboose-merge-method") as MergeMethod) || "squash");

  if (ws.archived || !status) return null;
  const b = status.branch;

  async function act(label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) {
    setBusy(label);
    const r = await fn();
    setBusy(null);
    if (r && !r.ok) alert(r.error);
    props.refresh();
  }

  async function askClaude(message: string) {
    const chat = activeChat(ws, props.chats);
    if (!chat) return;
    const r = await api.send(chat.id, message);
    if (!r.ok) return alert(r.error);
    props.onAskedClaude();
  }

  const local = [
    b.uncommitted > 0 && `${b.uncommitted} uncommitted`,
    b.upstream ? b.ahead > 0 && `${b.ahead} to push` : b.ahead > 0 ? `${b.ahead} commit${b.ahead === 1 ? "" : "s"}, not pushed` : "not pushed",
    b.behind > 0 && `${b.behind} to pull`,
    b.behindBase > 0 && `${b.behindBase} behind ${ws.baseRef}`,
  ].filter(Boolean);
  if (!local.length) local.push("Up to date with GitHub");

  const pr = status.available ? status.pr : null;
  const checks = pr ? checksSummary(pr.checks) : null;
  const open = pr?.state === "OPEN";

  return (
    <div className="gh-bar">
      <span className="gh-local muted">{local.join(" · ")}</span>
      {busy && <span className="muted">{busy}</span>}
      <span className="spacer" />

      {!status.available && <span className="muted" title={status.reason}>{status.reason}</span>}

      {status.available && (!pr || pr.state === "CLOSED") && (
        <>
          {pr && <PrLink pr={pr} />}
          <button className="primary" onClick={() => askClaude(createPrMessage(ws.branch, ws.baseRef, false))}>
            Create PR
          </button>
          <button onClick={() => askClaude(createPrMessage(ws.branch, ws.baseRef, true))}>Draft PR</button>
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
              {checks.failed > 0 && <span className="del">✗ {checks.failed} failed</span>}
              {checks.pending > 0 && <span className="pending">● {checks.pending} running</span>}
              {checks.failed === 0 && checks.pending === 0 && <span className="add">✓ checks passed</span>}
            </button>
          )}
          {pr.mergeable === "CONFLICTING" && <span className="del">Conflicts</span>}
          {b.upstream && b.ahead > 0 && <button onClick={() => act("Pushing…", () => api.push(ws.id))}>Push</button>}
          {checks.failed > 0 && <button onClick={() => askClaude(fixChecksMessage(pr))}>Fix checks</button>}
          {pr.mergeable === "CONFLICTING" && (
            <button onClick={() => askClaude(resolveConflictsMessage(pr))}>Resolve conflicts</button>
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
              if (confirm(`Merge PR #${pr.number} into ${pr.baseRefName} (${method})?${warn}`)) {
                void act("Merging…", () => api.merge(ws.id, method));
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
          <button onClick={props.onArchive}>Archive workspace</button>
        </>
      )}

      {props.error && <span className="del" title={props.error}>GitHub status failed</span>}

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
export function BranchName({ ws, status, onRenamed }: { ws: Workspace; status: GitHubStatus | null; onRenamed: () => void }) {
  const canRename = !ws.archived && status && !status.branch.upstream;
  return (
    <>
      <code>{ws.branch}</code>
      {canRename && (
        <button
          className="link"
          title="Rename branch"
          onClick={async () => {
            const name = prompt("New branch name", ws.branch);
            if (!name || name === ws.branch) return;
            const r = await api.renameBranch(ws.id, name);
            if (!r.ok) alert(r.error);
            onRenamed();
          }}
        >
          ✎
        </button>
      )}
    </>
  );
}
