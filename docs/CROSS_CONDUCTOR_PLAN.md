# Making Caboose feature-complete with cross_conductor

`~/home/varner/cross_conductor` (xc) is how Andreas runs cross-repo work today:
a coordinator agent writes a plan and one brief per repo, dispatches a subagent
per repo into git worktrees, and a local dashboard shows how it is going.
Caboose now has features (one worktree per repo), agents, Jira and PRs, so most
of the plumbing exists. This plan covers what is missing, and a calmer UI.

## What xc does, and where Caboose stands

| xc | Caboose today | Gap |
| --- | --- | --- |
| Project: slug, **title**, **status** (planning → active → review → done/paused), one **shared branch** (`TPM-11500_NightlyBatchSync`), Jira keys per project and repo, **dependsOn** between repos | Feature: station name, branch `caboose/<KEY>-<station>`, `jira.txt`, repos | title, status, branch template, dependencies, reuse of an existing branch |
| Docs as files: `README.md` (brief), `plan.md` (checklist, tickable), `repos/<repo>.md` (brief per repo), `log.md` (append-only, statuses, notes to agents) — committed to git | none | all of it |
| Coordinator agent dispatches one Claude **subagent** per repo (in waves, by dependency); subagents report with `xc status/log`, read `xc inbox`; questions are relayed by the coordinator | one feature-level chat that sees every repo | per-repo agents, status reporting, notes to agents |
| Agent activity from Claude transcripts: state, current tool, todos, files edited, errors, live feed across repos, per-run timeline and final report | live chat per tab | cross-repo activity feed and per-agent summary |
| Per repo: git state, last commit, PR (+checks, review), Jira status + summary | per repo: git state, PR, checks; Jira keys only | last commit, Jira status/summary |
| **Pull requests page**: totals (open/draft/merged, failing builds, unresolved threads, approvals, changes requested, repos without PR) and per PR: unresolved review threads with links, failed checks with links, merge state, size | per-repo PR row (state, checks, review) | totals, review threads, approvals, merge state, size |
| **Open in** VS Code / Rider (opens the single `.sln`) / Terminal (iTerm, Ghostty, Terminal) / Finder | Open folder | the app launchers |
| Start / resume `claude` in a terminal window with the kickoff prompt; copy kickoff prompt | in-app chats | kickoff prompts; optional `claude` CLI in a terminal tab |
| Startup scripts via Conductor run actions (`.conductor/settings.toml`) | `caboose.json` `run`/`setup` in the repo | scripts per repo in the machine config (work repos have no caboose.json) |
| Local files by Conductor's rules (`.worktreeinclude`, `file_include_globs` in `.conductor/*.toml`, the Conductor DB, `~/.conductor/settings.toml`) | per-repo rules in config | import those rules |
| Repo registry from Conductor's DB | repos in config | one-time import |
| Overview of all projects (cards) | sidebar list | an overview board |

## Phases

### 1. Continuity: import, branches, titles (small)
- **Import from Conductor** in Configure: repos (name, path, default branch), their
  local-file rules (`.worktreeinclude` / `file_include_globs`, incl. your global
  `.env`, `.env.local`, `**/appsettings.local.json`) and their run scripts from
  `.conductor/settings.toml`. Read-only, once; nothing depends on Conductor after.
- **Adopt xc projects**: turn `projects/<slug>/` (from every worktree of the xc
  repo) into Caboose features — title, status, repos, branches, Jira keys, docs,
  log — and adopt the existing worktrees in `~/xc-workspaces/<slug>/<repo>`
  instead of creating new ones.
- **Title and status** on a feature (status: planning, active, review, done,
  paused); the station name stays the id and folder name.
- **Branch template** in config, e.g. `{prefix}/{key}-{station}` (today) or
  `{key}_{Title}` (xc style, one shared branch across repos); per-repo override.
  **Reuse a branch** that already exists locally or on origin instead of always
  branching fresh (picking up work started elsewhere).

### 2. Open in apps and startup scripts (small)
- **Open in** per repo and for the feature folder: VS Code, Rider (the `.sln`/`.slnx`
  when there is exactly one), terminal app, file manager. Commands per OS, with
  overrides in config:
  - macOS: `open -a …` (iTerm / Ghostty / Terminal detected).
  - Windows: `code`, Rider from JetBrains Toolbox or `rider64.exe`, Windows Terminal (`wt -d`), Explorer.
  - Linux: `code`, `rider.sh` / Toolbox, `x-terminal-emulator` / `gnome-terminal`, `xdg-open`.
    *(Linux: which terminal to launch differs by desktop; there will be a setting.)*
- **Scripts per repo in the machine config**: setup, and any number of named
  run scripts (`dev`, `test`, `migrate`…), one marked default. `caboose.json` in a
  repo still adds to them. The Run menu lists them; each runs in its own terminal tab.

### 3. Feature docs (medium)
- In the feature folder: `brief.md`, `plan.md` (checklist), `repos/<repo>.md`
  (brief per repo), `log.md` (append-only: who, to whom, status, text) — the same
  formats as xc, so imported projects carry over and agents can read them.
- Plan ticks, brief and log are editable in the app (markdown preview, edit in place).
- **Versioning** (question 1): xc commits these to git. Proposal: if the features
  folder is a git repo, Caboose commits doc changes there with a short message.

### 4. Repo agents (large; the core of xc's workflow)
Instead of Claude subagents hidden inside one coordinator chat, Caboose runs
**one agent chat per repo** (in that repo's folder, started with its brief), next
to the feature-level **coordinator** chat. Every agent is visible, can be talked to
directly, and can ask *you* (question cards) instead of relaying through the
coordinator. Works with Claude and Copilot.
- Caboose tools for agents (MCP for Claude, SDK tools for Copilot):
  - repo agents: `ReportStatus(working|blocked|needs-input|ready|in-review|done, note)`, `Log(note)`;
  - coordinator: `StartRepoAgent(repo)` (creates the worktree if needed, starts the
    chat with the brief), `MessageRepoAgent(repo, text)`, `GetFeatureStatus()`
    (what `xc show` prints: every repo's state, git, PR, Jira, recent log),
    `GetPullRequests()` (what `xc prs` prints), `TickPlan`.
- Notes you write to "all" or to a repo go straight into that agent's chat (queued
  if it is busy), replacing xc's inbox polling, and are logged.
- **Dependencies and waves**: `dependsOn` per repo; "Start next wave" starts the
  repo agents whose dependencies are `ready`/`in-review`/`done`.
- Status per repo = what the agent last reported, overridden by facts (PR merged → done).
- Shipping stays gated: pushing, PRs and Jira only when you say so (unchanged).

### 5. Overview and dashboards, with less text (large)
The xc dashboard shows everything at once: every repo row carries the agent's
whole last report, Jira summaries, commit subjects and nine buttons. Caboose
should show **signals first, words on demand**:
- **Board** (new home screen): one row per feature — title, status chip, plan
  progress ring, one dot per repo coloured by state (hover: repo, state, PR), and
  badges only for what needs you (questions, blocked, failing builds, unresolved
  review threads). Click to open; expand in place for a one-line-per-repo summary.
- **Feature page**: a compact header (title, status, branch, Jira with status,
  progress) and a "Needs you" strip that is empty most of the time. Repo rows are
  **one line** each — state dot, name, PR chip with a ✓/✗/● check icon, Jira chip,
  "n commits ahead" — and expand to show the last report, last commit, agent stats
  (tools, files edited, errors), the brief, and an actions menu (open in…, run,
  changes, start/message agent, copy kickoff prompt).
- **Activity**: a single feed across repos, one line per event (time, repo
  colour, icon + tool summary); clicking a line opens that agent's chat at that
  point. Filter by repo; errors highlighted.
- **Plan, brief, log** as side panels or tabs, collapsed by default once the
  feature is active; log entries show their first line and expand.
- **Pull requests** tab: the totals as small tiles, a table with a row per PR;
  unresolved threads, failed checks and reviewers expand inline. GitHub data is
  fetched in one GraphQL call per feature (like xc), cached 60 s, with Refresh.
- **Jira**: status chips (and assignee on hover) for the task and subtasks, from
  one search call per feature.

### 6. Optional: agents outside Caboose
- "Start `claude` in a terminal" as a terminal tab running the Claude Code CLI
  with the kickoff prompt (for long interactive sessions you prefer in a TUI).
- Show activity from Claude Code transcripts (`~/.claude/projects/…`) for
  sessions started outside Caboose in a feature's folders, as xc does. Only if
  still wanted once Conductor is gone.

## Order and size
1 and 2 first (small, immediately useful, and they make your three live xc
projects openable in Caboose). Then 3 → 4 (the workflow), then 5 (the views,
which need 3 and 4's data). 6 last, if at all.

## Questions
1. **Feature docs in git?** Commit brief/plan/log to a git repo (the features
   folder as a repo), or plain files only?
2. **Agents:** visible per-repo agent chats coordinated through Caboose (proposed),
   or xc's model of Claude subagents inside one coordinator chat?
3. **Branch names:** one shared branch per feature (xc: `TPM-11500_NightlyBatchSync`)
   or one per repo with its subtask key (Caboose today)? Default template?
4. **Import:** bring your current xc projects and Conductor repos over (phase 1)?
5. **Apps on Windows/Linux:** VS Code and Rider everywhere? Which terminal app on Windows (Windows Terminal?) and Linux?
