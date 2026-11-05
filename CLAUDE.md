# Caboose — working notes for Claude

Desktop app (macOS + Windows) that runs Claude Code agents in parallel git
worktrees. Personal/team-internal, never commercial. Plan and status: `docs/PLAN.md`.

- **Auth belongs to Claude Code.** Agents run through the Agent SDK, which runs
  the official Claude Code binary under the user's own login. Never read, copy,
  store or forward its credentials, and never call the Anthropic API directly
  with them.
- **Every feature must work on macOS, Windows and Linux.** No POSIX-only shell
  commands, paths or signals in app code; spawn `git`/`gh` with `execFile` and
  argument arrays. Linux is not tested yet: **tell Andreas whenever a choice
  affects Linux compatibility** (native modules, OS integrations, packaging).
- **Runs from a clone** (`npm install && npm start`) on every machine. Keep
  native modules to a minimum and log new decisions in `docs/DECISIONS.md`.
