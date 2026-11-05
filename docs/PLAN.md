# Caboose plan

A personal (and maybe team-internal) desktop app, macOS, Windows and Linux, for running
coding agents (Claude Code, GitHub Copilot) in parallel git worktrees. Not for sale.

## Stack

| Part | Choice |
| --- | --- |
| Shell | Electron + React + TypeScript (electron-vite) |
| Agents | `@anthropic-ai/claude-agent-sdk` and `@github/copilot-sdk` in the main process |
| Git | the `git` CLI via `execFile`, one worktree per workspace |
| GitHub | the `gh` CLI |
| Terminal | `node-pty` + `xterm.js` |
| Storage | JSON state file; Claude Code keeps transcripts (see DECISIONS) |
| Diffs | `@git-diff-view/react` or diff2html |
| Packaging | none: run from a clone (`npm install && npm start`) |

The main process owns git, agent sessions, ptys and the database; the renderer
is UI only, over typed IPC. Workspaces live in `~/caboose/workspaces/<repo>/<name>`.
Per-repo config in `caboose.json`: setup/run/archive scripts and files to copy.

## Phases

Status: ✅ done · 🟡 started · blank = not started. Decisions: `docs/DECISIONS.md`.

0. ✅ **Proof of concept** — `npm run spike`. Done on macOS 2026-11-05 (Claude Max
   login, `apiKeySource: none`). Still to check on Windows and Linux.
1. ✅ **Skeleton** — window, add repository (validate it is git), JSON state, sidebar.
2. ✅ **Workspaces** — fetch, worktree on a new branch from `origin/main`,
   placeholder name, copy files, `.context/`, setup script, archive/restore.
3. ✅ **Chat** — one session per tab; stream text, thinking, tool calls/results;
   stop, queue, resume by session ID; model/effort/permission pickers; transcripts.
4. ✅ **Permissions and Caboose tools** — `canUseTool` → approval prompt; in-process
   MCP server with AskUserQuestion, GetWorkspaceDiff, DiffComment, GetDiffComments
   and GetTerminalOutput.
5. ✅ **Diff and review** — `git diff origin/main...` + untracked, polled
   while visible; inline comments sent to the agent.
6. ✅ **Terminal and run script** — a pty per workspace; a unique port per workspace.
7. ✅ **GitHub** — create PR, status, checks, merge, rename branch.
8. ✅ **Polish** — notifications, multiple tabs, shortcuts, settings, theme,
   updates by `git pull`.
9. 🟡 **Later** — ✅ GitHub Copilot as a second agent (official SDK); other agents
   via ACP, checkpoints, remote access.

## Windows from day one

- Claude Code needs Git for Windows; run repo scripts through its `bash`.
- Stop processes with a tree kill (`tree-kill`), not signals.
- `core.longpaths=true` for worktrees; watch for CRLF in diffs.
