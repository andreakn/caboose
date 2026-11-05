# Caboose plan

A personal (and maybe team-internal) desktop app, macOS and Windows, for running
Claude Code agents in parallel git worktrees. Not for sale.

## Stack

| Part | Choice |
| --- | --- |
| Shell | Electron + React + TypeScript (electron-vite) |
| Agent | `@anthropic-ai/claude-agent-sdk` in the main process |
| Git | the `git` CLI via `execFile`, one worktree per workspace |
| GitHub | the `gh` CLI |
| Terminal | `node-pty` + `xterm.js` |
| Storage | SQLite (`better-sqlite3`) |
| Diffs | `@git-diff-view/react` or diff2html |
| Packaging | electron-builder (`.dmg`, NSIS) |

The main process owns git, agent sessions, ptys and the database; the renderer
is UI only, over typed IPC. Workspaces live in `~/caboose/workspaces/<repo>/<name>`.
Per-repo config in `caboose.json`: setup/run/archive scripts and files to copy.

## Phases

0. **Proof of concept** — `npm run spike`. Done on macOS 2026-11-05 (Claude Max
   login, `apiKeySource: none`). Still to check on Windows.
1. **Skeleton** — window, add repository (validate it is git), SQLite, sidebar.
2. **Workspaces** — fetch, worktree on a new branch from `origin/main`,
   placeholder name, copy files, `.context/`, setup script, archive/restore.
3. **Chat** — one session per tab; stream text, thinking, tool calls/results;
   stop, queue, resume by session ID; model/effort/permission pickers; transcripts.
4. **Permissions and Caboose tools** — `canUseTool` → approval prompt; in-process
   MCP server with AskUserQuestion, GetWorkspaceDiff, GetTerminalOutput, DiffComment.
5. **Diff and review** — `git diff origin/main...` + untracked, live via
   chokidar; inline comments sent to the agent.
6. **Terminal and run script** — a pty per workspace; a unique port per workspace.
7. **GitHub** — create PR, status, checks, merge, rename branch.
8. **Polish** — notifications, multiple tabs, shortcuts, settings, theme,
   auto-update, installers.
9. **Later** — other agents via ACP, checkpoints, remote access.

## Windows from day one

- Claude Code needs Git for Windows; run repo scripts through its `bash`.
- Stop processes with a tree kill (`tree-kill`), not signals.
- `core.longpaths=true` for worktrees; watch for CRLF in diffs.
- Unsigned builds are fine for personal use (SmartScreen / Gatekeeper warnings).
