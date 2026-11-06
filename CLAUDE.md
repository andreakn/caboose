# Caboose — working notes for Claude

Desktop app (macOS, Windows, Linux) that runs coding agents (Claude Code,
GitHub Copilot) in parallel git worktrees. Personal/team-internal, never commercial. Plan and status: `docs/PLAN.md`.

- **Auth belongs to the agents.** Claude runs through the Claude Agent SDK (the
  official Claude Code binary), Copilot through GitHub's Copilot SDK (the
  official Copilot CLI runtime), each under the user's own login. Never read,
  copy, store or forward their credentials, and never call the model APIs
  directly with them.
- **A feature is the unit of work**: `<features folder>/<station>/` with one
  worktree per repo (`src/main/core/features.ts`). Chats run in the feature
  folder; changes, PRs and run scripts are per repo. `jira.txt` in the feature
  folder is the record of its Jira links; the Jira token never reaches the
  window (`configView`).
- **Local files** (`core/localfiles.ts`): only files git *ignores* are copied
  into a feature, never merely untracked ones (they would become changes).
- **Central chat + repo chats** (`core/coordination.ts`): a chat without a repo
  works in the feature folder; with one, in that repo's worktree. Caboose's
  tools for agents are one table in `core/mcp.ts` (Claude MCP and Copilot
  tools from the same definitions). Feature files (`brief.md`, `plan.md`,
  `briefs/`, `log.md`) are plain files (`core/docs.ts`); write the log only by
  appending.
- **One chat engine, one adapter per agent** (`src/main/core/chats.ts`,
  `src/main/core/agents/`). Agent-specific code stays in its adapter; the
  transcript format (`src/shared/chat.ts`) is Caboose's own.
- **Every feature must work on macOS, Windows and Linux.** No POSIX-only shell
  commands, paths or signals in app code; spawn `git`/`gh` with `execFile` and
  argument arrays. Linux is not tested yet: **tell Andreas whenever a choice
  affects Linux compatibility** (native modules, OS integrations, packaging).
- **Check UI changes in the real app**: `npm run build`, start Electron with
  `--remote-debugging-port` and a throwaway `CABOOSE_DATA`, then drive it with
  `scripts/drive.ts` and look at the screenshots.
- **Runs from a clone** (`npm install && npm start`) on every machine. Keep
  native modules to a minimum and log new decisions in `docs/DECISIONS.md`.
