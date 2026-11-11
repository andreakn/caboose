# Decisions

Made while Andreas was away (2026-11-05). Each one is easy to reverse; the
questions at the bottom are the ones that need an answer.

1. **Run from a clone, no installers.** Every machine does `git clone`, `npm
   install`, `npm start`. Packaging/signing moves to "maybe later" in the plan.
2. **No native modules (yet).** SQLite (`better-sqlite3`) is dropped for now:
   native modules must be rebuilt for Electron on every OS, which fights
   "clone and run". App state is one JSON file (`state.json`, written
   atomically). Chat transcripts will not need a database either: Claude Code
   already stores sessions and the SDK resumes them by ID. `node-pty` (Phase 6)
   will be the first native module; it ships prebuilt binaries.
3. **Two kinds of local config.**
   - `caboose.local.json` in the Caboose checkout (gitignored, example in
     `caboose.local.example.json`): this machine's settings — workspaces
     folder, branch prefix, bash path.
   - App state (repos, workspaces, setup logs) lives in Electron's per-user
     data folder (`~/Library/Application Support/Caboose`,
     `%APPDATA%\Caboose`, `~/.config/Caboose`), so re-cloning Caboose loses
     nothing. `CABOOSE_DATA=<dir>` points the app elsewhere.
4. **Per-repo config is `caboose.json` in the repo**: `setup`, `run`,
   `archive`, `copy`. Scripts run through `bash -lc` on every OS (Git for
   Windows' bash on Windows, found next to `git.exe`), so one file works on
   all machines. Scripts get `CABOOSE_WORKSPACE_NAME/PATH`, `CABOOSE_ROOT_PATH`,
   `CABOOSE_BRANCH`.
5. **Workspaces**: `~/caboose/workspaces/<repo>/<station>`, branch
   `caboose/<station>` (prefix configurable), branched from
   `origin/HEAD` (else the current branch) after a `git fetch` that is allowed
   to fail offline. The branch is created **without** upstream tracking so a
   plain `git push` can never push to main.
6. **Names are Nordic railway stations** (Norway, Sweden, Denmark, Finland), in ASCII.
7. **`.context/` is excluded via `.git/info/exclude`**, not the repo's
   `.gitignore`, so Caboose never makes a change you did not ask for.
8. **Archive = run archive script, remove worktree, keep branch.** Restore
   checks the branch out again at the same path and re-runs setup.
9. **Removing a repo** is refused while it has live workspaces.
10. **Electron 45 + electron-vite 6 + React 19 + TypeScript 7.** ESM
    throughout; the preload is ESM, so the window runs with `sandbox: false`
    (it only ever loads our own files; navigation is blocked, links open in
    the browser).
11. **npm's install-script allowlist**: only `electron` may run an install
    script (to download its binary); `fsevents` is denied. Recorded in
    `package.json` → `allowScripts`.
12. **Core logic has no Electron imports** (`src/main/core/`), so it is tested
    with plain `node --test` against real git repos.
13. **Theme**: own light/dark palette with a caboose-red accent, following the
    OS. Not linked to the family theme.css.

## Phase 3: chat (2026-11-05)

14. **Caboose uses the SDK's own Claude Code binary**, not the `claude` on
    PATH. npm installs the right one per OS (macOS, Windows, Linux x64/arm64,
    musl too), and `package-lock.json` pins the version, so every machine runs
    the same Claude Code. Update with `npm update @anthropic-ai/claude-agent-sdk`.
    Login is shared with your installed Claude Code.
15. **One live Claude Code process per open chat**, fed through streaming
    input; it stays alive between messages and is ended when the tab closes,
    the workspace is archived or the app quits. After a restart the next
    message resumes the session by id (verified with real Claude).
16. **Our own transcript** per chat (`chats/<id>.jsonl` in the app data
    folder): a small event format we control (`src/shared/chat.ts`), used
    both for live updates and replay. Claude Code's own session files are
    still what `resume` uses.
17. **Messages sent while Claude works are queued by Caboose** (shown dimmed)
    and sent when the turn ends; Stop (or Esc) interrupts and drops the queue.
18. **Approvals arrived early** (planned for Phase 4): in "Ask before acting"
    and "Accept edits" modes, tool calls that need permission show
    Allow / Always allow / Deny. AskUserQuestion is still answered with "ask
    in plain text" until Phase 4.
19. **Defaults for a new chat**: the workspace's previous chat's settings,
    else default model, effort high, **Accept edits** (file edits in the
    worktree go through; commands ask).
20. **Subagents' own messages are hidden**; the Agent tool's result shows
    their report.
21. **Settings, CLAUDE.md, MCP servers and hooks load like in the terminal**
    (the SDK default: user, project and local settings).
22. **Tabs arrived early** (planned for Phase 8). Closing a tab deletes its
    transcript, after a confirm.

## Phases 4–5: questions, Caboose tools, changes (2026-11-05)

23. **Claude's multiple-choice questions** (Claude Code's own AskUserQuestion
    tool) are answered in a card in the chat: pick options, or type "Other".
    Typing a normal message while a question is open answers it in words
    instead (Claude is told you replied in the chat).
24. **Caboose's own tools for Claude** are an in-process MCP server named
    `caboose`: `GetWorkspaceDiff`, `DiffComment`, `GetDiffComments`. They run
    without asking (they only read the diff or write review comments).
    `GetTerminalOutput` waits for the terminal in Phase 6.
25. **A short note is appended to Claude Code's system prompt** in every
    chat: that it runs in Caboose, which worktree/branch/base, `.context/`,
    and the tools above. Claude Code's own prompt stays as is.
26. **"Changes" means everything a PR would show once committed**: committed
    on the branch since the merge-base with the base ref, plus staged,
    unstaged and untracked files.
27. **The Changes view polls** (every 4 s while the window is visible, and on
    focus) instead of watching files: file watchers behave differently on
    macOS, Windows and Linux (inotify limits), and a few git commands are
    cheap. *(Linux-relevant: avoids inotify.)*
28. **Our own unified diff view** instead of a diff library: it was the
    simplest way to put comments under lines. Side-by-side may come later.
    Diffs over 4000 lines and binary files are not shown.
29. **Review comments live in the app state** (`comments` in `state.json`),
    per workspace, on a line of the new file (or the old file for removed
    lines). "Send N comments to Claude" sends one message to the open chat tab
    and marks them sent; Claude can also read them with `GetDiffComments`.
    Claude's own comments show with a green edge.
30. **Chat and Changes are two views** of a workspace (switch at the top),
    not side by side: a side-by-side split was too tight at laptop widths.

## Phase 6: terminals and the run script (2026-11-05)

31. **Terminals use `@lydell/node-pty`**, a repackaging of Microsoft's
    node-pty with ready-built binaries per OS as optional npm packages (like
    the Claude SDK). No compiler, no install script, and it loads in Electron
    without a rebuild. *(Linux: x64 and arm64 with glibc are covered; musl
    distros such as Alpine are not. Upstream `node-pty` would compile on Linux
    and needs build tools there.)* It is a beta version; if it ever lags,
    switching to upstream `node-pty` is a one-line change.
32. **Shell**: `$SHELL -l` on macOS/Linux, PowerShell (7 if installed) on
    Windows; `shellPath` in `caboose.local.json` overrides. The run script
    always goes through bash, like setup, so `caboose.json` works everywhere.
33. **Each workspace gets 10 ports** starting at 41000 (`CABOOSE_PORT` = the
    first), set in setup/run scripts and terminals and told to Claude. Kept
    per workspace in the state; freed when archived. Caboose does not set
    `PORT` itself: do `PORT=$CABOOSE_PORT npm run dev` in `run` if wanted.
34. **Terminals live in memory**: they end when the app quits (or the
    workspace is archived) and are not restored. Run again with ▶ Run.
35. **Stopping** hangs up the whole process group on macOS/Linux; on Windows
    closing the ConPTY ends its processes.
36. **Terminal output is batched per frame** (16 ms) on its way to the window,
    and each terminal keeps its last 256 KB for redraws and for Claude.
37. **`GetTerminalOutput`** gives Claude the last lines (escape codes
    stripped) of the Run terminal, or a terminal by title.
38. **Terminal font**: a list of common Nerd/Powerline fonts first (your
    zsh prompt uses those symbols), then monospace; `terminalFont` in
    `caboose.local.json` overrides.
39. **`scripts/drive.ts`** drives the real app over the Chrome DevTools
    protocol (evaluate JS, wait, screenshot), so UI changes can be checked
    end to end without clicking by hand.

## Phase 7: GitHub (2026-11-05)

40. **`gh` owns the GitHub login**; Caboose calls `gh` and `git` and keeps no
    tokens. Without `gh`, or for repos whose `origin` is not on GitHub, the
    bar only shows the local branch status and says why.
41. **Judgement goes to Claude, mechanics to Caboose.** "Create PR" / "Draft
    PR", "Fix checks" and "Resolve conflicts" send Claude a message in the
    open chat tab (commit what belongs, push, `gh pr create --base <base>`,
    follow the repo's conventions). Push, Merge, status, checks and branch
    rename are run by Caboose directly.
42. **Status refreshes** every 15 s while the window is visible, on focus,
    after every chat turn in the workspace, and after each action.
43. **Merge asks first** (with a warning for failing or running checks), uses
    the method you last picked (squash by default), is disabled for drafts
    and conflicts, and does **not** delete the branch: the worktree still has
    it checked out. After merging, the bar offers "Archive workspace".
44. **Renaming a branch is only offered before it is pushed**: renaming a
    pushed branch would cut it off from its PR.
45. **Links open in the browser** only for `https://` URLs.
46. **Tested against GitHub for real**: a throwaway workspace on this repo,
    "Draft PR" clicked in the app, Claude (Haiku) committed, pushed and
    opened draft PR #1; it was closed and its branch deleted right after.
    Merge is covered by a test of the `gh` call, not run against GitHub.

## Phase 8: polish (2026-11-05)

47. **Activity is tracked per chat in the window** (working / needs you /
    finished unseen) and shown as dots on workspaces and chat tabs. A chat on
    screen in a focused window counts as read.
48. **System notifications only while Caboose is in the background**, for
    "done" (silent) and "needs you" (with sound); clicking one opens that
    chat. Switch off in Settings. The dock/taskbar badge counts chats that
    finished unseen or wait for you *(Linux: badges only show on desktops that
    support them, such as Unity/KDE; harmless elsewhere)*.
49. **A real app menu** with the standard Edit/Window menus (copy/paste need
    them on macOS) and Caboose's commands with shortcuts (README). Reload moved
    to Cmd/Ctrl+Shift+R so Cmd/Ctrl+R can be Run.
50. **Settings page** edits `caboose.local.json` and applies it without a
    restart (new workspaces and terminals use it). Theme and notifications are
    window preferences (localStorage), not in that file.
51. **Theme**: follow the system, or force light/dark (also sets Electron's
    `nativeTheme`, so menus and dialogs match).
52. **Prerequisite checks** ("doctor"): git, bash, Claude Code (version and
    login, asked from a Claude Code session that is started and ended without
    sending anything), gh and its login, Node/Electron. Meant for setting up a
    new machine, Windows especially.
53. **Updating Caboose** = `git pull --ff-only` of its own checkout, `npm
    install` only if `package.json`/lock changed, `npm run build`, restart.
    Refused when the checkout has local changes or commits. *(Tested with a
    fake app repo; not yet by updating Caboose itself.)*
54. **The window opens where it was closed**, unless that place is no longer
    on a screen.

## GitHub Copilot as a second agent (2026-11-05)

55. **Copilot runs through GitHub's official Copilot SDK** (`@github/copilot-sdk`),
    which runs the Copilot CLI runtime that npm installs per OS (like the
    Claude SDK; macOS, Windows, Linux x64/arm64 incl. musl). It uses the
    user's own GitHub login and Copilot plan; Caboose keeps no tokens.
56. **Login: the GitHub CLI's** (`gh auth login`) or the Copilot CLI's own.
    Classic personal access tokens (`ghp_…`) in `GH_TOKEN`/`GITHUB_TOKEN` are
    hidden from the Copilot runtime: Copilot rejects them, and they hid
    Andreas's real gh login on this Mac. Other tokens pass through.
57. **One engine, two adapters.** `core/chats.ts` owns transcripts, queue,
    approvals and questions; `core/agents/claude.ts` and
    `core/agents/copilot.ts` translate their SDKs (`core/agents/types.ts` is
    the seam). A third agent (ACP, Codex…) is another adapter.
58. **The agent is chosen per chat tab** ("+" → Claude Code / GitHub Copilot);
    a new tab otherwise uses the open tab's agent. Old chats are Claude.
59. **Copilot's models come from the user's plan** (disabled ones hidden);
    effort is offered per model where Copilot supports it.
60. **Permission modes map onto Copilot**: reads inside the worktree are
    allowed; "Accept edits" also allows writes inside it; "Bypass" allows
    everything; "Plan only" switches Copilot to its plan mode; everything else
    shows the approval card ("Always allow" = for this session).
61. **Copilot's questions** (`ask_user`) use the same question card; a reply in
    the chat answers in words.
62. **Caboose's tools for Copilot** are SDK tools (`caboose_get_workspace_diff`,
    `caboose_diff_comment`, `caboose_get_diff_comments`,
    `caboose_get_terminal_output`), same handlers as Claude's MCP tools, run
    without asking.
63. **koffi's install script is denied**: the Copilot SDK only needs it for its
    experimental in-process mode, which Caboose does not use.
64. Size: the Copilot runtime adds ~160 MB to `node_modules` per machine.
65. **Tested for real** with Claude Haiku 4.5 through Copilot: Caboose's diff
    tool, a question answered on the card, a shell command approved, the
    answer; and a Claude chat afterwards, to check nothing broke.

## Features replace workspaces (2026-11-06)

Asked for by Andreas: a new session is a *feature* with a station name and its
own folder; it can span several repos; it can be tied to Jira.

66. **A feature is a folder** `<features folder>/<station>/` with one git
    worktree per repo in a subfolder named after the repo, a `.context/`
    scratch folder, and an optional `jira.txt`. Repos can be added later.
    Archive removes the worktrees and keeps the branches and the folder;
    restore puts them back.
67. **Chats belong to the feature and run in the feature folder**, so the
    agent sees every repo; its system note lists the repos, branches, ports
    and Jira keys and says to run git inside each repo folder. Chat tabs stay
    (one is enough, more cost nothing).
68. **Changes, the GitHub/PR row and Run are per repo** (each repo gets its own
    branch and PR). Caboose's agent tools take an optional `repo`.
69. **Ports**: 100 per feature from 41000; repo *i* gets `CABOOSE_PORT` =
    port + 10·i (also `CABOOSE_FEATURE_PORT`, `CABOOSE_FEATURE`,
    `CABOOSE_FEATURE_PATH`, `CABOOSE_REPO`).
70. **Terminals**: as many as wanted per feature, each opened in a chosen repo
    or in the feature folder ("+" menu).
71. **Branch names**: `<prefix>/<station>`, or `<prefix>/<KEY>-<station>` with
    the repo's subtask key (else the feature's task key), so the branch
    contains the Jira key — that is what links work to Jira. PR titles need no
    key prefix.
72. **Jira levels** (config): Off / Optional (link by hand, create subtasks on
    request) / Expected (new features ask, one click to skip; Create PR warns
    without a key) / Required (no feature without a task; each repo's subtask
    is created automatically, in the task's project, with the project's
    sub-task type).
73. **Jira over its REST API** with email + API token (Andreas had the MCP
    route in mind; trying this one first). The token is encrypted with the OS
    keychain (Electron `safeStorage`) and never sent to the window. *(Linux:
    needs a keyring such as GNOME Keyring or KWallet; without one the token is
    stored in plain text in the config file, and Configure says so.)* Only
    https sites are accepted (http only for localhost, for tests).
74. **`jira.txt` is the record** of a feature's links (task on the first
    line, `repo: KEY` lines after); Caboose reads it each time, so hand edits
    count, and agents can read it.
75. **The config file now holds the repos** (machine-specific paths) and Jira;
    app data holds features and chats. First launch (no config file) opens
    the Configure screen; "⚙ Configure" opens it later. Repos are added one at
    a time or by scanning a folder such as `~/code`; names must be unique.
76. **No migration** of the old one-repo workspaces (only demo data existed);
    old chats and comments are ignored.
77. `CABOOSE_CONFIG_DIR` points the app at another config folder (tests).
78. **Tested end to end** in the app against a fake Jira server: first run,
    Jira "Required" + connection test, a feature with two repos from an
    existing task (two subtasks created, keys in the branch names and
    jira.txt), a terminal per repo with its own port, and a Claude chat in the
    feature folder reading both repos and jira.txt. Real Jira is untested.

## Local files per repo (2026-11-06)

Andreas: bringing the right gitignored files (.env, *.local.*) from the main
checkout is essential for a repo to run in a feature, and each repo has its
own rules.

79. **Rules per repo in the machine config** (`repos[].localFiles`), so work
    repos need no Caboose file of their own. A repo's `caboose.json` `copy`
    list still adds to them. Repos without rules use the defaults
    `.env*` and `*.local.*`.
80. **Patterns work like .gitignore**: no slash = file name at any depth,
    a slash = from the repo root, trailing slash = a whole folder, `**`,
    `* ? {a,b}`, `!` to leave out (later lines win), `#` comments.
81. **Only files git ignores are copied.** Tracked files are in every worktree
    already, and untracked-but-not-ignored files are work in progress that
    would show up as changes in the feature (and could be committed by an
    agent). Configure's live preview lists those as "left out".
82. **The search skips big generated folders** (node_modules, .venv, dist,
    build, target, .next, vendor, …) and symlinks, and stops after 200 000
    entries.
83. **Copied before the setup script runs**, so `npm install`/dev servers see
    them. The feature remembers what it copied (Feature details), and
    "↻ copy again" brings them over again from the main checkout,
    overwriting the feature's copies.

## cross_conductor parity, phases 1–2 (2026-11-06)

See `docs/CROSS_CONDUCTOR_PLAN.md` for the plan and Andreas's answers.

84. **Import from Conductor** (Configure → Repositories): reads Conductor's
    database read-only with Node's built-in `node:sqlite` (no native module;
    works in Electron 45). Repos (one per checkout), their copy rules in
    Conductor's order (`.worktreeinclude`, `file_include_globs` in
    `.conductor/settings.local.toml` then `settings.toml`, the DB, the global
    `~/.conductor/settings.toml`, else `.env*`), their scripts, and the global
    create-PR prompt as Caboose's PR instructions. Only on macOS (where
    Conductor is); nothing is written to Conductor.
85. **Repos added by hand** pick up rules from `.worktreeinclude` /
    `.conductor/*.toml` too, on any OS. A ~150-line TOML reader
    (`core/toml.ts`) covers what those files use.
86. **Scripts per repo in the machine config** (setup, named run scripts,
    archive), with the repo's `caboose.json` adding to them. The Run menu lists
    every repo's scripts; "Run all" starts each repo's first script. Each runs
    in its own terminal tab (`<repo>: <script>`).
87. **PR instructions** in the config are added to every Create PR request.
    With a Jira key, Caboose only asks the agent to mention the key in the
    description: the branch name is what links a PR to Jira (Andreas), so a
    key prefix in the title is neither required nor forbidden.
88. **Open in** per repo and for the feature folder: VS Code everywhere;
    Rider on macOS/Windows (the single `.sln`/`.slnx` if there is one); Visual
    Studio on Windows (`devenv`, newest year/edition found); terminal = iTerm,
    Ghostty, Warp or Terminal on macOS, Windows Terminal (else PowerShell) on
    Windows, the first of gnome-terminal/konsole/xfce4-terminal/kitty/alacritty/
    wezterm/x-terminal-emulator/xterm on Linux; Finder/Explorer/xdg-open.
    Only folders Caboose knows can be opened. `openWith` in the config
    overrides any app with a command (`{path}`). *(Linux: no Rider/Visual
    Studio, per Andreas; the terminal is whichever is installed.)*
89. **Title and status** (planning, active, review, done, paused) on features;
    the station name stays the id and folder name.
90. **A feature with a Jira task gives every repo a subtask** (when Jira is
    connected), at any level, not only "required". Linking a task later
    creates the missing subtasks and renames branches that are not pushed yet
    to `<prefix>/<SUBTASK>-<station>`; pushed ones are left alone and reported.

## cross_conductor parity, phases 3–4 (2026-11-06)

91. **Feature files** in the feature folder, plain markdown, not in git:
    `brief.md`, `plan.md` (a checklist; progress = share ticked),
    `briefs/<repo>.md`, `log.md` (append-only; entries
    `### <time> · <from>[ → <to>][ · status: <s>]`, xc's format). The Plan tab
    shows them collapsed (first lines only) and edits them in place; it re-reads
    them every 4 s while open, since agents write them too.
92. **A chat can belong to a repo** (`Chat.repo`): it works in that repo's
    worktree, can also read the feature folder (`additionalDirectories`), and
    gets its own system note. Chats without a repo are the feature's central
    chat (feature folder). Both kinds live side by side as tabs (⑂ marks repo
    chats); start with the central chat and break out repos that need focused
    follow-up, from the "+" menu, the repo row, the Plan tab, or by the central
    chat itself.
93. **Coordination tools** for the agents (Claude MCP / Copilot tools, one
    table in `core/mcp.ts`): `ReportStatus` (queued, working, blocked,
    needs-input, ready, in-review, done), `Log`, `GetFeatureStatus` (per repo:
    reported status, chat state, git, PR and checks, Jira; plan progress; recent
    log), `StartRepoChat` (creates the repo chat with a standalone kickoff: the
    feature's files, how to report, "don't push/PR/Jira unless asked", the
    task; if the repo has a chat, the task goes there), `MessageRepoChat`
    (queued if busy), `GetRepoChat`.
94. **Repo agents ask the user directly** (question cards in their own chat)
    instead of relaying through the coordinator as xc's subagents had to. The
    feature view's **Needs you** strip lists chats waiting for an answer or
    approval and repos that reported needs-input/blocked; it is empty most of
    the time.
95. **Notes from the user** (Plan tab → Log) are logged and sent to the chats
    they are for: a repo's chat (else the central chat, "about <repo>"), or
    every chat. This replaces xc's inbox polling.
96. **`prompt()` replaced** by an in-app dialog (`Dialog.tsx`): Electron has no
    `window.prompt`, so the branch-rename and Jira-link buttons did nothing
    before.
97. **Tested for real** (Claude Haiku): the central chat wrote brief, plan and
    a repo brief, broke out a `sheets` chat, which edited and committed in its
    worktree, reported working → ready, logged the commit and ticked the plan.

## cross_conductor parity, phase 5: overview (2026-11-06)

98. **Signals first, words on demand** (Andreas found xc's dashboard too wordy):
    one coloured dot per repo (red = needs you: needs-input/blocked, failing
    checks, conflicts, changes requested, unresolved review comments; yellow =
    working or checks running; blue = on track; green = merged/done; grey =
    nothing yet), with the reason on hover; badges only for what needs you.
99. **Board** (sidebar "▦ Board"): a row per live feature — name, title,
    status, plan progress, repo dots, "n asking" / "n need you" badges, the
    Jira task's status; expands to a line per repo.
100. **Repo rows are one line**: dot, name, reported status, PR chip (#n with
     ✓/✗/● for checks and 💬 for unresolved comments), Jira chip with its
     status, a short local state, **the one action that matters now** (Create
     PR / Fix checks / Resolve conflicts / Push / Merge) and a ⋯ menu with the
     rest (draft PR, merge methods, open PR, open in apps, rename branch, Jira
     link/create/unlink, the repo's chat). Click the line for the details.
101. **PR details in one GitHub GraphQL call per feature** (`gh api graphql`):
     the newest PR per repo branch with unresolved threads, reviews and
     requested reviewers, checks (failed ones with links), merge state and
     size; cached 60 s, refreshed every 30 s while shown, "Refresh" bypasses
     the cache. Repos whose origin is not on GitHub show "not on GitHub".
102. **Jira status** for the task and every subtask in one search, cached 60 s.
103. **Pull requests tab**: totals as tiles (open, draft, merged, failing
     builds, unresolved comments, approved, changes requested, repos without a
     PR) and a row per repo that expands to its failing checks and comments.
104. **Activity tab**: every chat of the feature in one feed, newest first, one
     line per event (your messages, replies, tool calls, questions, errors),
     filterable by chat; a click opens that chat. Chat events are now
     time-stamped when saved (older transcripts have no times and are left
     out of the feed).
105. **Tested against live GitHub**: the caboose repo in a test feature, its
     branch pointed at the old test PR #1, which showed up (closed, size,
     merge state) on the board, the repo row and the PR tab. Jira statuses
     from a fake Jira server.

## New feature, Conductor-style (2026-11-06)

106. **The New feature dialog is one optional text box** (plus the Jira task
     when Jira is on). Enter with it empty creates an empty feature (no repos)
     to build out with "+ Add a repo"; with a description, the feature is
     created, titled from the first line, and the text goes to its central
     chat as the first message.
107. **The agent proposes repos; the user decides.** The central chat's
     system note lists the configured repos it can add (main checkouts, to
     read but never change) and, for an empty feature, asks it to work out
     which repos the request needs. `ProposeRepos` shows a card: each
     suggestion with its reason, ticked; the user can untick, add other repos
     ("+ another repo…"), add the chosen ones, or decline all. Caboose adds
     the worktrees (and Jira subtasks), then tells the chat what was added and
     what was not. The agent can propose repos at any time, not just at start.
108. **Proposals do not block the agent**: the tool returns at once and the
     answer arrives as a message, so a long wait cannot time out a tool call,
     and a card can still be answered after a restart. Unknown repo names are
     refused with the list of real ones; repos already in the feature are
     dropped from the card.
109. **`SetFeatureTitle`** lets the central chat give the feature a short
     title (it replaced "Add a line saying…" with "Touched by Caboose README
     note" in the test).
110. New chats take their settings (model, effort, mode) from the latest chat
     anywhere when their feature has none yet.

## Claude or Copilot as the main agent (2026-11-06)

111. **A main agent setting** (`defaultAgent` in the config; Configure → Main
     agent, also on the first-run screen): Claude Code or GitHub Copilot. Each
     option shows whether that agent is logged in on this machine; on first
     run the logged-in one is preselected (Claude if both or neither). New
     features, new chats and repo chats use it unless another agent is picked
     (the "+" menu on chat tabs, the switch in the New feature dialog).
112. **Neither agent has to be installed separately**: both runtimes come with
     Caboose through npm (Claude Code with the Agent SDK, the Copilot CLI
     runtime with the Copilot SDK). Only a login is needed: Claude Code's own
     (`/login`, in the copy that comes with Caboose or your own `claude`), or
     the GitHub CLI's for Copilot.
113. **The prerequisite checks mark the other agent optional** ("–" with a
     muted hint) instead of failing.
114. A new feature always gets its central chat at once, with the chosen
     agent, so even an empty feature starts with the right one. Saving in
     Configure now updates the open window straight away.

## Permissions like Conductor (2026-11-06)

115. **New chats start in "Bypass permissions"**, as Conductor runs Claude Code
     (`--permission-mode=bypassPermissions`), so agents run commands without
     asking. It is a setting (`defaultMode`; Configure → Permissions for new
     chats: ask before acting / accept edits / plan only / bypass). Each chat
     can still change its own mode in the picker under the message box.
116. **The mode no longer follows the previous chat**: a new chat always
     starts in the configured mode (model and effort still follow the last
     chat with the same agent), so the setting is what you get.

## The Run tab (2026-11-06)

117. **A Run tab like cross_conductor's runner**: per repo, `run.sh` and
     `run_<moniker>.sh` at the worktree's root (same regex), `# url:` lines
     or a localhost URL in the header comment for 🌐, ▶ / ■ / ↻, "▶ all",
     "▶ Run feature", "■ Stop all". The run scripts from Configure and
     `caboose.json` are listed too, unless they only call one of those files.
     The header's ▶ Run opens the tab; Cmd/Ctrl+R runs the whole feature.
118. **Programs run in Caboose's own terminal tabs, not iTerm**, so it works
     the same on macOS, Windows and Linux; "show" opens the terminal panel
     on that tab. A program's state comes from its pty: running, exited (its
     tab stays so you can read why; ↻ or ■ to close), or stopped (no tab).
119. **Stop is graceful everywhere**: Ctrl-C into the pty, up to 10 s, then a
     hang-up; the Run tab then closes the tab. The terminal panel's stop
     button and archiving a feature use the same Ctrl-C-first stop.
120. **Programs outside the Run tab** (cross_conductor's "strays"): anything
     listening on TCP whose command line names a file in one of the
     feature's worktrees and is not a descendant of a Caboose terminal.
     Stopping one sends SIGTERM to it and up to three launchers above it
     (`dotnet run`, `npm run dev`), never a shell, Caboose or Caboose's
     direct children (the agents), then SIGKILL after 8 s. Whatever holds a
     port a script's URL uses is shown on that script too, with where it
     runs from (another feature, a main checkout). Caboose only stops
     programs that run from a folder it knows or from its own terminals.
     *Linux:* needs `lsof` or `ss` (iproute2) for this; without either the
     tab works and says it cannot see strays. *Windows:* PowerShell's
     Get-NetTCPConnection and Win32_Process (untested so far).
121. **The moniker file is optional** (`monikersFile`, Configure →
     Terminals), the same format cross_conductor reads; nothing depends on
     it but labels.

122. **Caboose follows the branch a worktree is on now**, not only the one it
     made: an agent (or you) may switch to a branch named after the Jira
     task (`ABC-8241_FixStartupMapping`). PRs are looked up by the
     checked-out branch, and the recorded branch is updated, so push, merge
     and renames use it too. A detached HEAD keeps the recorded one.

123. **Pull and "Merge <base>" on the repo row.** Pull when the upstream has
     commits you don't (fast-forward, else a merge); "Merge master" when the
     base has moved (e.g. after a squash-merged PR), as the row's main
     button when nothing more urgent is waiting. Both run locally; if a
     merge conflicts it is aborted (nothing changes), the files are named,
     and you can ask the agent to do the merge. A merge commit is chosen
     over a reset: it works the same whether the PR was squashed or not and
     never throws work away.
124. **Caboose fetches origin while it shows a feature**, at most every
     2 minutes per worktree (and right after merging a PR or before a pull
     or merge), so "to pull" / "behind master" are current. The fetch never
     prompts and gives up after 20 s.

## Archive or delete (2026-11-06)

125. **"Archive…" asks: archive or delete.** Both close the feature's open
     and draft PRs (`gh pr close`, merged/closed ones are left alone) and
     delete its branches, locally and on origin. Archive then moves the
     feature folder (brief, plan, log, jira.txt) to
     `<archiveRoot>/<yyyy-mm-dd_hh-mm>_<station>/` with its chats as
     readable markdown plus the raw `.jsonl`, the setup logs, and a
     `feature.json` record; delete deletes them. Either way Caboose forgets
     the feature (no Restore: its branches are gone). `archiveRoot` defaults
     to `~/caboose/archive` (Configure → Features).
126. **The dialog first shows what would happen**: per repo the branch, the
     PR and its state, and work that would be lost (uncommitted changes,
     unpushed commits). Delete asks once more.
127. **Order, so a failure cannot leave a half-dead feature**: PRs are
     closed first and if one cannot be closed nothing else happens. After
     that, chats, programs and terminals stop (Ctrl-C first), archive
     scripts run, worktrees and branches go; failures there are reported as
     warnings and the rest carries on. Main branches (main, master, develop,
     trunk, the base) are never deleted. Features archived the old way
     (worktrees removed, branches kept) still offer Restore, and the same
     dialog.

## Feature and repo levels, and Files (2026-11-06)

128. **Two levels under the header**: a bar with **Feature** and one tab per
     repo (health dot, changed-file count). Feature holds what the repos
     share: the one-line repo rows, details, and Chat (every chat), Plan,
     Run (all programs), Pull requests, Activity. A repo holds its own row
     (Pull/Push/PR actions) and Files, Changes, Chat (its break-out chats,
     or a button to start one) and Run (its programs). Changes are per repo
     only; there is no feature-wide list any more. The level and the repo
     tab are remembered.
129. **Files is what git sees** (`git ls-files --cached --others
     --exclude-standard`: tracked plus untracked, never ignored, so no
     node_modules or bin/), as a tree with single-child folders on one line
     (`apps/web/src`), change letters on files and a dot on folders with
     changes, quick-find by typing (characters in order, file names first),
     and "Show changes" for a changed file. The viewer shows text with line
     numbers, markdown rendered (or source), images; binaries and files over
     2 MB are only named. No syntax colouring yet. Reading refuses any path
     that leaves the worktree, symlinks included.

130. **A repo can have a friendly name** (`label` in its config entry;
     Configure → Repositories, next to its name). It is what the screen
     shows: repo tabs, repo rows, the sidebar, Run, Pull requests, the
     Board, Plan, dialogs. The repo's `name` stays the id: folder name in a
     feature, branch and Jira mapping, agent tools and instructions.

131. **Merged is purple**, as on GitHub (`--merged`: #8250df light, #a371f7
     dark): a repo's dot and PR chip once its PR is merged, and a feature's
     sidebar dot once every repo's PR is merged (only an agent waiting for
     you or working outranks it). The Board marks such features "all
     merged".
132. **When every branch of a feature is merged, the feature page offers to
     archive it** (opens the archive-or-delete dialog). "Not now" hides the
     offer until the set of PRs changes. A merged repo no longer makes
     "Merge master" its main button (it stays in the ⋯ menu).

133. **Tabs look like tabs, and each level is a panel of its own shade.**
     The Feature/repo bar is a row of folder tabs opening onto a tinted
     panel; that panel's tabs (Chat, Files…) open onto a card-coloured panel
     inside it; chat tabs are a third, quieter row. The Feature level is
     tinted with the accent (warm), a repo level with blue (`--info`), so the
     colour says where you are. Shades are mixed from the theme tokens, so
     light and dark both work.

134. **Vertical room over repetition.** The Feature level no longer lists
     the repo rows: they live in its **Repos** tab (was Pull requests), under
     the PR totals. Repo tabs carry the PR number and its check mark. Inside
     a repo, its status, main action and ⋯ sit at the end of its tab row,
     with branch/report/PR details behind ⓘ. The header is one line (title
     inline, "+ add a title" only on hover); feature details (folder, ports,
     setup, copied files) moved behind ⓘ next to Open. One chat shows no
     chat tab row ("+" in the corner); the message box starts one line high
     and grows; gaps are tighter.

135. **The diff viewer has three views: Diff, Original, Changed.** Original
     is the file at the merge-base Changes compares with (`git show`; the old
     path for renames), Changed is the worktree copy; images show as images,
     markdown as source. The choice is remembered; a view a file cannot have
     (Original of a new file, Changed of a deleted one) is disabled.
136. **"VS Code ↗" opens the feature folder in VS Code at that file**, at the
     first changed line from the diff (double-click a diff line for that
     line; the Files viewer has the button too). It uses VS Code's own
     command-line tool with `-g file:line`, so a window already showing the
     feature is reused: on macOS the one inside the app bundle (no need for
     "code" on PATH), on Windows `bin\code.cmd`, on Linux `code`/`codium`.
     An `openWith.vscode` override gets the folder as `{path}` and `-g` added.

137. **Sounds when an agent is done or needs you**, like Conductor's ping:
     whenever a chat you are not looking at finishes, or asks a question or
     for a permission (the same moments as the notifications). Configure →
     Sounds: a sound per event (Ping, Chime, Bell, Pop, Train whistle, or
     none; defaults Ping for done, Bell for needs you), volume, and "only
     while Caboose is in the background". Synthesised with Web Audio, so no
     sound files and the same on every OS; several chats at once ring once.
     Kept per machine in the window's storage, like the theme.

138. **Configure is split into tabs**: Agents (main agent, permissions, PR
     instructions), Repositories, Features & Jira, Apps (open in, terminals,
     moniker file), Look & sound (theme, notifications, sounds), System
     (prerequisite checks, updates). The last tab is remembered; Save stays
     at the bottom and saves every tab at once.

139. **"Open in" is an app icon with ▾, like Conductor's**: the icon of the
     app you opened last (one click opens there again) and a menu of the
     others, with their real icons (macOS: Quick Look thumbnails of the .app,
     as Electron's getFileIcon gives a generic one; Windows: the .exe's icon;
     Linux: a glyph). The feature's sits next to ▶ Run in the header (the
     feature folder), a repo's next to its Run tab (its worktree). The last
     app is remembered across both.
140. **Caboose never waits on macOS's "reopen windows?" prompt** after a
     crash (`ApplePersistenceIgnoreState`): every Electron app run from a
     clone shares the "Electron" app identity, so another one crashing made
     Caboose start with no window, waiting on a dialog that could be
     off-screen.

141. **Stations have proper names on screen** (Bodø, Åndalsnes, Östersund,
     Helsingør, Seinäjoki): `shared/stations.ts` keeps the ASCII id (folder,
     branch, `CABOOSE_FEATURE`, archive folder) and the name, country and
     position of every station. Non-ASCII ids were rejected: folders handle
     æøå, but some Windows shells and build tools do not, macOS stores ø/å
     in decomposed form (so text matching of paths, as the stray-program
     check does, can miss), and branch names end up percent-encoded in URLs.
142. **The map** (sidebar → Map): the Nordics as a metro map, the real lines
     drawn as straight connections between stops, hubs (Oslo, Stockholm,
     København, Helsinki…) always shown, and a station's dot only once a
     feature has been named after it. Its colour is the feature's state:
     green active, brown while GitHub checks run, purple merged; once ended,
     light purple (merged, archived), grey (merged, deleted) or red
     (abandoned: ended without every PR merged). Ended features are kept in
     `visits` in the state file (station, title, repos, dates, how it ended)
     for the map and for later gamification. The sidebar dot shows brown
     while checks run too.

143. **About 1,750 stations from OpenStreetMap instead of 122 hand-picked**
     (`scripts/stations-from-osm.ts` → `src/shared/stations-data.ts`, run by
     hand when the data should be refreshed; the queries are at the bottom of
     the script). Kept: named railway stations and halts in the four
     countries; dropped: metro, tram, light rail, heritage and tourist lines.
     Countries: Sweden from its own query, the rest by position (south of
     57.9°N is Danish, east of 20°E Finnish). Names lose "station"/"stasjon"
     and the second language ("Mo i Rana / Måefie"). Track: consecutive stops
     of every train route relation, express hops dropped, gaps filled from
     the hand-drawn main lines where OSM has no route mapped (about 72% of
     stations end up on a drawn line; the rest show as a dot alone). The
     first 122 keep their ids, so existing features keep their names. The
     map credits OpenStreetMap (ODbL).

144. **The map zooms** (scroll or pinch around the pointer, double-click to
     zoom in, drag to pan, + / − / ⟲ in the corner, up to 30×): it changes
     the svg's viewBox, and dots, labels and line widths are scaled back so
     they stay the same size on screen. The track no longer highlights on
     hover.

145. **Folders in the sidebar**: "+ Folder" under the features; folders
     nest; drag features and folders to reorder them or drop them on a
     folder to put them in it (top or bottom edge of a row = before/after,
     a folder's middle = inside; a folder cannot go into itself). Click a
     folder to open or close it, double-click or ⋯ to rename; deleting one
     moves what it held up a level. The layout is `sidebar` in the state
     file (folders, each folder's ordered contents, which are closed); new
     features join the end of the top level, ended ones drop out, and
     next/previous feature follow the tree's order. The logic is pure
     (`shared/sidebar.ts`) and tested.

146. **Which release carries a feature** (optional): release *stages* are
     named tag patterns, `release = *_v*`, `test = *_TEST_v*`,
     `prod = *_PROD_v*` (Configure → Repositories → Releases, for all repos;
     each repo can use its own or switch it off). Once a repo's PR is
     merged, its merge commit (from GitHub) is looked up with
     `git tag --contains`, and per stage the lowest version tag is shown
     next to the PR: `🏷 shop_v1.114 · test ✓ · prod –`. A tag matching
     several patterns counts for the last one, so `*_v*` does not also claim
     `shop_TEST_v1.114`. Repos that tag several services (`orderws_v1.335`,
     `stockws_v1.004`) get the lowest tag per prefix. Off until stages are set.

147. **The sidebar shows how deployed a feature is**: per release stage
     (environment) a small bar with a segment per repo that has tag rules,
     filled once that repo has a tag for the stage (and "2/3" when there are
     several). Repos without tag rules do not count. Shown once a tracked
     repo has a PR; hover for which repos are tagged.

148. **Flush panels**: the level panels no longer have side borders,
     rounded corners or side padding, and the page margin is 12 px; the tint
     (warm for the feature, blue for a repo) and the folder tabs are enough
     to show the nesting, and the width goes to the content.

149. **Changed lines are marked in the file viewers** (Files, and the diff
     viewer's Changed view): a thin bar beside the line numbers, green for
     new lines, amber for changed ones, and a red tick where lines were
     removed, all against the branch's base. Within a change block, as many
     added lines as were removed count as changed, the rest as new. The marks
     are positioned by line number over the gutter, so the code stays one
     plain block however long the file is.

150. **Running programs are visible across features.** The sidebar shows
     `▶ 1/3` next to a feature with programs running (green when all of its
     programs run, amber when some; hover lists them), since a running
     program holds its port. A start button for a program (same repo, same
     script) already running in another feature gets an amber outline and
     a "⚠ running in Korsør" tag beside it; hovering explains, clicking goes
     to that feature.

151. **Long chats stay reachable**: the repo proposal's button says "Add
     selected (n)" instead of naming every repo; the chat turns off the
     browser's scroll anchoring (it could fight the wheel while output
     streams in above), and a "↓ Latest" button appears when you are scrolled
     well up, jumping to the end.

152. **Archiving or deleting is quick**: open PRs are closed all at once,
     then every repo is handled at the same time; a worktree is moved into
     `.caboose-trash` beside the features (same disk, so instant), git
     forgets it (`worktree prune`) and the files are deleted in the
     background (leftovers are cleared when Caboose starts); the remote
     branch is deleted in one push (a missing one is fine) instead of a
     check and a delete; the plan uses local git facts without fetching. A
     7-repo feature with 20,000 files per worktree went from 5.6 s (local
     remotes, more with GitHub's round-trips) to under 0.1 s.

153. **CI on macOS, Windows and Linux** (`.github/workflows/ci.yml`):
     typecheck, the tests and a build at every push, with real git; the
     Electron binary is not downloaded (nothing needs it to test or build).
154. **Agents can run what they build** (ListPrograms, StartProgram,
     StopProgram, FetchLocal; for Claude and Copilot). Programs start in the
     user's Run tab, where they see them and Caboose manages the ports;
     StartProgram waits until the program's declared URL answers, it exits,
     or the wait is up, and returns which, with its recent output and any
     port conflict. FetchLocal only reaches http://localhost. The
     instructions tell agents to use these instead of starting servers in a
     shell, which leaves programs holding ports.

155. **Releases are followed after a feature ends, and announced.** When a
     feature is archived or deleted, its merged repos' merge commits are kept
     with it (`visits[].releases`), and every few minutes Caboose reads the
     tags of live and ended features alike. When every tracked repo of a
     feature is tagged for a stage (test, prod…), a notification and the
     "done" sound say so, once (`releaseNews` in the state; the very first
     look only remembers what had already shipped). On the map a gold ring
     marks a feature that has reached its last stage everywhere. Jira is not
     touched: it follows the branch names.
156. **Windows, from what CI found.** Closing terminals now waits for their
     processes to end, and quitting waits up to 3 s for running ones: on
     Windows a process that exits while a ConPTY is still closing can hang
     in its exit. Tests run with `--test-force-exit` for the same reason.
     Moniker paths that do not exist on the machine are compared resolved
     (drive letters). Tests read git checkouts with CRLF in mind, since Git
     for Windows converts line endings by default.
157. **A home area, and names that spread from it.** The home area is a
     point picked on the map (first-run setup, Features tab, or the Map page
     later), saved as `home` in `caboose.local.json` since it is the
     person's, not the repo's. A new feature is named after one of the 4
     nearest free stations, so the map fills in outwards from home with a
     little variety. Stations of ended features (visits) now count as taken
     too, so every feature is a new dot; names only repeat ("-2") once all
     1,757 are used. Without a home area, names come from anywhere, as before.
158. **Lines: repos that belong together, so a feature never mixes them.**
     For consultants with several customers (and their own projects). A
     line is just a name on a repo (`line` in `caboose.local.json`); it
     exists while some repo is on it, so there is nothing to create or
     delete. A repo on no line serves every line, so nothing changes until
     the first repo gets one: then New feature offers a line (Any by
     default, or the last one used), the feature header shows a line chip,
     and Configure lists repos per line. A feature on no line takes the line
     of the first repo on one that joins it. Adding a repo from another line
     is refused (create, add, the agents' proposals), and agents are only
     told about the repos their feature can have. Named "line" (a railway
     line) rather than "universe". Lines have settings of their own (159).
159. **A line's own settings.** `lines.<name>` in `caboose.local.json` can
     set the features folder, archive folder, branch prefix, PR instructions,
     release tags and Jira; anything absent is the general setting
     (`forLine` in config.ts, `lineConfig` for the window). Jira is taken as
     a whole: a line with its own Jira has its own site, account, token and
     project (or "off"), because mixing one customer's site with another's
     token is never right. Tokens are sealed like the general one and follow
     a rename (`renamedFrom`). A feature with no line chosen takes its first
     repo's line at creation, so its folder and Jira are the line's from the
     start. Release tags: a repo's own, else its line's, else the general
     ones. Configure shows a Lines tab only while some repo is on a line.
     The codebase stays generic: no customer's names, keys or services in
     code, tests or docs (examples use Acme, ABC, shop).
160. **What runs where, from the repo's own script.** Tags start deploys;
     approval steps and failing pods mean a tag is not proof. A repo's
     `.caboose/running.sh` prints `component env version` lines (two fields
     for a repo with one component); a version starts with the tag that made
     its release, so Caboose finds the longest tag it starts with (and that it
     does not continue: v1.4 is not v1.43's) and asks git whether that tag
     contains the merge commit. The script stays simple: it knows nothing
     about features, PRs or Jira. It runs from the main checkout with the
     user's credentials, cached a minute, 20 s limit; a failure shows as
     "could not tell", never as "not running". Deploy progress counts what
     runs where a repo has the script and tags elsewhere; tagged-not-running
     is shown as pending. Ended features keep being checked until their
     change runs everywhere. Announcements say "runs in" when confirmed.
     Not modelled: an "approved" state (the script only sees what runs).
161. **A feature's components.** For repos with several monikers, a feature
     records which ones it touches (`Feature.components`), set in the picker
     behind the running chips or by the agent (SetComponents, mentioned to
     agents only when a repo has several components). Only those are shown
     and counted; their release tags too. None chosen: all count.
162. **A `.caboose/` folder in repos** holds Caboose's files to keep the
     root tidy: `config.json` (else `caboose.json`), `run.sh`,
     `run_<moniker>.sh` (run from the repo root; the root's wins on a clash)
     and `running.sh`.
163. **Slash-command completion in the message box** (like Conductor's).
     Typing "/" lists what the chat's Claude session offers: skills (the
     user's, the project's, plugins'), project commands and Claude Code's own,
     from the SDK's `supportedCommands()` (minus internal, removed and renamed
     ones). Without a live session in that folder, one is started only to ask
     (no message, so no tokens; about 0.2 s) and closed; the list is cached
     per folder for 5 minutes and refreshed for free by live sessions.
     Copilot chats get none: its SDK has no way to list the user's skills.
164. **A permission request shows enough to judge it.** It shows the
     agent's own description of the command, why it asks (the SDK's
     `decisionReason`: a hook's `permissionDecisionReason`, a rule), labels
     for what a shell command does that matters (commits, pushes, posts to
     GitHub, discards changes, deletes files, changes a PR or a cluster,
     sends data; found anywhere in it, also inside a script it writes and
     runs), and the whole command, not its first line. Asks in Bypass mode
     come from the user's own hooks or rules, which win over the mode.
165. **A PR GitHub would merge now gets a green "✓ Merge".** "Cleared" is
     GitHub's own `mergeStateStatus` CLEAN (or HAS_HOOKS): required checks
     and reviews done, no conflicts, up to date where that is required.
     Otherwise the button stays as it was, and its tooltip says what is
     missing (a review or check, the branch behind its base, a draft).
166. **Archived features can be opened read-only, and continued.** They
     are read from the archive folders (`feature.json`, `chats/NN-*.jsonl`,
     brief/plan/briefs/log), not from the state, so older archives show up
     too and moving an archive folder away is all it takes to hide one. They
     are listed under "Archived" in the sidebar and open from the map. The
     view shows each used chat as it ended (anything left open shown closed),
     the files, and the repos with their deleted branches. **Continue…** makes
     a new feature (a new station): the chosen repos still configured on that
     line, on fresh branches from their base (the old ones were deleted), the
     same line, title and Jira task with the repos' subtasks, the brief, plan
     and briefs, the log with a note, and every chat's transcript in
     `history/`. Its chats show the earlier conversation above a marker. The
     agents start new sessions (Claude sessions are tied to the old folder,
     and resuming them across folders is not something to rely on) and are
     told the transcripts are in `history/`, so they read what they need.
     The archive itself is left as it was; the feature records
     `continuedFrom`, and the archived view says what it was continued as.
167. **Caboose's own icon**: a red caboose at dusk (lit windows, cupola,
     stove pipe, the red marker lamp at the end of the train), drawn as
     `assets/icon.svg`. `assets/icon.png` (1024 px) is rendered from it with
     Electron (`npx electron scripts/make-icon.mjs`, any OS) and committed.
     Run from a clone, Caboose is Electron itself, so the icon is set at
     runtime: the Dock icon on macOS, the window icon on Windows and Linux.
168. **"Caboose", not "Electron", in Cmd-Tab, the Dock and the menu bar.**
     macOS names an app after the bundle it launched, which from a clone is
     node_modules' Electron.app. `npm start` now runs `scripts/start.mjs`:
     on macOS it keeps `.caboose-app/Caboose.app` (gitignored), an APFS clone
     of Electron.app with its own name, bundle id (`com.caboose.app`) and
     icon, signed ad hoc like the original, made again when Electron or the
     icon changes; then it starts that. Other OSes start Electron as before.
     The new identity means macOS may ask once to let Caboose read its
     keychain item (the sealed Jira tokens): Always Allow.
169. **The user's to-do list** (`todo.md`, the To do tab): steps only the
     user can do (run a migration in an environment, set a secret, change a
     setting in a console). Agents add them with `AddTodo` (title, markdown
     details with the exact commands, the repo; the asking chat is recorded),
     and are told to do so instead of only mentioning such steps in a reply.
     Plain markdown like the plan, so agents and the user can also edit it.
     The tab shows open steps first, code blocks with a copy button; ticking
     one is logged (so agents see it in the log and in GetFeatureStatus,
     which lists open to-dos), and "Tell … it is done" messages the chat that
     asked. The tab and the sidebar show how many are open. Separate from
     plan.md, which is the work's checklist, not the user's chores.
170. **How chatty a chat is: a Show picker under the message box.** Three
     switches: progress notes (the agent's messages between steps), thinking
     and tool calls. Always shown: the user's messages, each turn's last
     message (its answer), and whatever needs the user or says what happened
     (questions, permissions, repo proposals, errors, results). A finished
     turn's hidden steps become one line ("··· 2 tool calls, 2 notes and 1
     thought hidden") that opens that turn; a running turn hides them without
     a line, and the working indicator says what the agent is doing ("is
     working: Bash `npm test`"). A streaming message is shown (it may be the
     answer); streaming thinking only when thinking is on. One choice for
     every chat, kept on this machine; the default is everything, as before.
     The filtering is shared code (`visibleItems`, tested).
171. **Asking Copilot for a review**, for repos that do not do it on their
     own: "Copilot review" on a repo with an open (or draft) PR, and "Copilot
     review all (n)" in the feature's Repos tab. Both go through
     `gh pr edit --add-reviewer @copilot` and skip PRs where a Copilot request
     is already pending (it is a bot, `copilot-pull-request-reviewer`, so the
     PR query now asks for bots among requested reviewers too); a pending one
     shows as "Copilot reviewing…". Asking again after Copilot has reviewed
     is allowed: it then reviews what is new.
172. **The Files tab shows what git ignores too, faded** (translucent and
     italic): ignored files (.env) one by one, and ignored folders
     (node_modules, bin) as one entry that is read a level at a time when
     opened, so huge folders cost nothing until looked into. Quick-find covers
     ignored files and opened folders, not the insides of unopened ones.
173. **Create PRs for the whole feature.** "Create PRs (n) ▾" in the
     feature's Repos tab, for the repos on GitHub with work (uncommitted
     changes, or commits their base does not have: the new `aheadBase`) and
     no PR yet (or only a closed one); also as drafts. Like the per-repo
     button it asks an agent rather than running `gh` itself: one message to
     the feature's chat, which works across every repo, listing each repo's
     branch, base and Jira key, with the same steps, the line's PR
     instructions, and a request to note dependencies and merge order
     between the PRs. With Jira "expected", repos without a key are named
     before asking.
174. **A repo tab says how far its change has shipped**: 🏷 release tagged,
     🧪 in a test environment, 🚀 in production (the emoji by the stage's
     name), the furthest stage reached by tags or, where the repo has a
     running.sh, by what runs; the tooltip has every stage ("prod –
     tagged, not running yet"). Once the PR is merged the changed-files
     count leaves the tab: it says nothing new then, and the mark takes
     its place.
175. **Each repo says how its releases are made** (`releaseStrategy`, in
     Configure → the repo's releases, or the repo's own
     `.caboose/config.json`; this machine's setting wins):
     - **"tag"**: someone cuts the next version. Caboose does it like the
       user's tagdeploy script: fetch, the highest `<prefix>_v<major>.<minor>`
       of a prefix (numerically; a patch part dropped, zero padding kept,
       `ignoreTags` never counted nor produced), the minor + 1, tagged on
       the tip of origin's base branch (so the checkout need not be on it),
       and only that tag pushed. A merged repo with no release yet offers
       "Tag release…" as its main action (and the ⋯ menu always): one row
       per tag prefix with latest and next, the prefixes of the feature's
       components ticked; it warns when the PR is not merged yet. The log
       records the tag. The deploy-time timer of tagdeploy is left out:
       Caboose follows releases itself.
     - **"merge"**: every merge to the base is a release and goes to test
       (the bff and storefront way), so a merged PR counts as reached for
       the stages up to the first test-like one ("merged #12"); later
       stages still need their tags (or a running.sh).
176. **A repo's own Caboose files come from its main line**, not from
     whatever the main checkout has on disk: `.caboose/config.json` (and
     `caboose.json`) and `.caboose/running.sh` are read with
     `git show origin/HEAD:<path>` (origin's default branch), origin fetched
     in the background at most every 2 minutes; where origin has none, the
     main checkout's copy is used (unpushed, or no origin). running.sh stays
     one script per repo (one answer for every feature, and it still works
     for ended features whose worktrees are gone), run as a temporary file
     from the main checkout's folder; but a feature that changed running.sh
     itself (since its branch left its base, committed or not) runs its own
     copy from its worktree, so a new script can be tried before it is
     merged. Run scripts stay on the feature branch, as before.
177. **Which chats the Dock badge counts, and where they are.** The badge
     counts chats that wait for an answer or finished unseen, in live
     features only. A 🔔 with the same number in the sidebar header lists
     them ("Torup · shop's chat · needs your answer"); a click opens that
     chat where it lives (its repo's tab, or the feature's), which marks it
     seen. On the way there: a count on each feature in the sidebar (and on
     a closed folder), and a dot on the feature's Feature/repo tabs (red:
     waiting for you; blue: finished). `openChat:<id>` is the one command
     that opens a chat anywhere; notifications and "Needs you" use it.
178. **"Open PRs" at the top of a feature once every repo is ready.** When
     every repo without a PR has reported "ready" (work committed) and has
     something to open a PR for, the header gets a green "Open PRs (n)" with
     a ▾ for "Open draft PRs". It sends the same one message to the
     feature's chat as "Create PRs" in the Repos tab (decision 173), for
     those repos.
179. **Before PRs are opened, Jira is offered for branches without it.**
     Every way of opening PRs (the header's Open PRs, the Repos tab's Create
     PRs, a repo's Create PR) first checks, unless Jira is off or not set
     up: with no feature task, it asks to create one (summary prefilled with
     the title; typing a key or issue link links an existing task instead)
     and a subtask per repo; with a task but repos without subtasks, it asks
     to create those under it. Keys go into branches not pushed yet (Jira
     automation follows the branch name); pushed ones are named, as their
     PR description is then where the key is. "Open without Jira" is offered
     unless Jira is required. Creating a task for an existing feature is
     new (`Features.createTask`); before, only a new feature could.
180. **Jira issues get the fields their project requires.** Before creating
     a task or subtask, Caboose reads the project's create metadata for that
     issue type; a required field it would leave out (with no default) gets
     the parent task's value (people by account id, options by id), or, for
     a person field, the user; a field it cannot fill is named in the error
     ("requires Team on a new Task…: create it in Jira and link its key")
     instead of Jira's bare HTTP 400. Found with a project whose sub-tasks
     require an "Owner".
181. **A description that starts with a Jira key gives the feature its
     task** ("NWP-8259 Feature toggle…"), when the Jira field is empty and
     Jira knows the key (so "UTF-8 everywhere" does not count); New feature
     shows the key it will use and does not warn about a missing task.
182. **"Fix CI" on failing builds, per repo and for the feature.** A repo
     whose open PR fails its checks always shows a red "Fix CI" (before, a
     "Fix checks" main action only appeared when nothing else came first),
     asking its own chat (or the feature's) to look; the feature's header
     shows "Fix CI (n)" when any repo fails, one message to the feature's
     chat for all of them. The message lists each failing check with its
     link, says how to read the failed run (`gh run view --log-failed`),
     to fix, check locally and push; and, when a failure is not the
     change's fault (flaky, runner, outage), to say so and re-run the failed
     jobs instead of changing code.
183. **Caboose's agent sessions are marked: `CABOOSE=1`** in their
     environment (Claude sessions also `CABOOSE_FEATURE` and, for a repo
     chat, `CABOOSE_REPO`; the Copilot client, shared by all chats, only
     `CABOOSE=1`). Hooks inherit it, so the user's own hooks can treat
     Caboose's sessions differently; e.g. a hook that asks before every
     `git commit` can start with `[ -n "$CABOOSE" ] && exit 0;` to let
     Caboose's agents commit on feature branches while still asking
     everywhere else.
184. **Notifications say what they are about**, not the chat's title (its
     first message). Title: where and what happened ("Torup · shop: Claude
     asks" / "needs your approval" / "is done" / "stopped"); body: the
     question asked, what the approval is for and why it asks, the first
     line of the final answer, or the error (`noticeBody`, tested).
185. **Copilot's verdict is shown, and asking again only when it helps.**
     Copilot reviews as comments (never GitHub "approvals"), with its verdict
     as the review's heading ("### 🟢 Approval recommended"). Caboose reads
     its latest review (body, time, the commit it reviewed) and shows a chip:
     "Copilot 🟢 Approval recommended" (🟡 issues, 🔴 changes), faded with
     "(older commit)" when there are newer commits it has not seen. The
     Copilot review buttons (per repo, and "all" for the feature) only offer
     PRs it has not reviewed at their latest commit and has not been asked
     to; then the per-repo one reads "Copilot review again".
186. **A line can set the default release strategy for its repos**
     (Configure → Lines → "Releases are made by"). A repo's own setting
     (Configure) wins, then its `.caboose/config.json`, then its line's
     default; so a line whose repos are mostly tagged sets "tag" once, and
     only the exceptions ("every merge is a release": bff, storefront) say
     otherwise. A repo's releases link shows what applies ("as its line").
187. **After a merge, a repo shows what is still relevant.** Copilot's
     verdict and "N behind <base>" (status line, details, the merge-base
     action) only while the PR is open. The Changes view keeps showing what
     the branch brought in after a merge with a merge commit: where a
     branch's tip is already part of its base, it is compared with the base
     as it was before the merge that brought it in (that merge's first
     parent), not with its own tip; a branch with no commits of its own is
     not mistaken for one (every later merge's first parent already has it).
188. **Approving a prod deploy is a click away.** When a repo's release has
     reached the stage before a prod-like one (🚀) but not that one, the prod
     chip reads "prod – approve ↗" and opens, in the browser, the workflow
     run waiting for approval that one of the release's tags started (`gh run
     list --status waiting`); if there is none, the repo's Actions list of
     waiting runs. Never another run: a waiting run of another service's tag
     is not this release's.
189. **A check run again counts by its latest run.** GitHub keeps every run
     of a check on a commit (a PR title fixed, a job re-run), so an old
     failure stayed in the list and the PR read as failing. Both ways
     Caboose reads checks (`gh pr view`, the PR details query) keep only each
     check's latest run, by when it started.
190. **A PR waiting for an approval says so.** When GitHub blocks the merge
     and what is missing is an approving review (blocked, checks not failing
     or running, no changes requested, nobody approved), the repo shows
     "⏳ waiting for approval" (who was asked in its tooltip) and its Merge button reads
     "Merge (blocked)". Review requests to teams are read too (by name);
     before, only people and bots were, so a request to a team was invisible.
191. **A Copilot verdict that is not a green light can be dismissed** (×),
     once the user has looked at it. The dismissal is for that review (kept
     per PR with the review's time, on this machine): a newer Copilot review
     shows again.
192. **The repo status line says it in icons.** The agent's report shows only
     where git and GitHub cannot: 🧠 working, ✋ needs input, ⛔ blocked,
     ⏸ queued ("ready", "in review" and "done" are hidden). The PR's merge
     state is a mark on the PR chip (⚠️ conflicts, ✋ changes requested,
     ⏳ waiting for approval, 🟢 ready to merge), not a chip of its own. Copilot
     is one icon, which replaces its button too: 🤖… reviewing, 🤖 plus its
     verdict (🟢 / 🟡 / 🔴 / 💬, ↻ when it has not seen the latest commit; a
     click shows the verdict to dismiss or ask again), or 🤖↻ to ask for a
     review. Tooltips carry the words.
193. **Merge uses a method the repo allows.** The PR query reads the repo's
     allowed merge methods (squash, merge commit, rebase); Merge uses the
     method last used if the repo allows it, else the first it does, and the
     menu offers only those. Before, it always squashed, which repos that
     allow only merge commits refuse.
194. **Azure sign-ins per tenant, per line.** A line lists its Azure tenants
     (name, tenant id, store folder); each program (run script) picks one in
     the Run tab, kept per repo in the machine's config, and starts with that
     tenant's store as `AZURE_CONFIG_DIR`. That is what a shell script that
     sets the variable before starting a service does, done in Caboose so it
     works on machines without the script. A store is "signed in" only if
     `az account get-access-token --tenant` succeeds: `az account show` keeps
     answering after the sign-in has run out. Checks are cached a minute and
     repeated every 5 minutes while the Run tab is open; Sign in runs `az
     login --tenant` into the store (the browser opens). Starting a program
     whose tenant is not signed in offers to sign in first.
195. **Linking a repo to Jira is first-level.** A repo with no issue of its
     own has a key box in its status line, next to the main action (a PR
     wants the key): type or paste, Enter. Agents get a LinkJira tool and are
     told a repo is linked only once it succeeds; before, a chat could only
     write "linked" in the log, which linked nothing. The window re-reads the
     links whenever the overview refreshes, so an agent's link shows up.
196. **Platforms: a feature delivered in waves, one after another.** The
     station (folder, chats, log, plan, to-dos, Jira task) stays; each
     platform has its own goal, repos and branches. The next one starts once
     the current one's work is merged or closed (an open PR, commits without
     a PR or uncommitted changes block it). Repos that stay get a new branch
     from their base, `<prefix>/<KEY>-<station>-p<n>`, in the same worktree,
     so their chats keep their folder and carry on (unlike Continue, which
     needs new sessions); repos that leave lose their worktree, new ones are
     added. Jira, as chosen per platform: new subtasks named after the goal,
     or the same subtasks and the task moved back to In Progress (through a
     transition to an in-progress status, preferring one named so). The
     ended platform is kept on the feature with its PRs and merged repos'
     releases, followed like an ended feature's (and announced as
     "platform n"), unless marked superseded; archiving carries the counted
     ones over to the station visit. `plan.md` gets a section per platform,
     and the agents' instructions and GetFeatureStatus say which platform it
     is and what the earlier ones did. Platforms side by side (their own
     worktrees, stacked branches) come later.
197. **A branch's PR is found by the name it was pushed under.** A branch can
     be pushed to origin under another name (`git push -u origin
     caboose/x:ABC-1_Thing`, so the remote name carries a Jira key for
     reporting); a PR's head is that remote name. The overview, the status
     line, merging and archiving look the PR up by the upstream's name on
     origin (else the local name), and Push pushes to that name again instead
     of making a second remote branch with the local name.
198. **Going to the feature or a repo opens its chat.** Clicking the Feature
     tab or a repo's tab opens its Chat tab (now the leftmost of a repo's
     tabs too) on its default chat: the feature's central chat (its first)
     or the repo's first chat. Other tabs are a click away; a new repo view
     starts on Chat as well.
199. **🤖💭 in the sidebar while Copilot reviews** one of a feature's open
     PRs (it was asked and has not answered), gently pulsing (still for
     reduced motion); the tooltip names the repos and PRs.
200. **What runs can be a commit, not only a tag.** Some repos deploy every
     push to the main line untagged and version it by its short sha, which
     running.sh then reports. A version no tag matches that is 7 to 40 hex
     digits (then the end, or something that cannot continue it) is resolved
     as a commit, and checked for the merge commit like a tag. Tags still
     win. Components can stand for anything deployed on its own, such as one
     app per brand, so a partial rollout shows per component.

## Answered (2026-11-05)

- Private GitHub repo `andreakn/caboose`: yes.
- Branch prefix: `caboose`.
- Names: railway stations from all the Nordic countries.
- Linux: tested later. Flag any choice that affects Linux compatibility.
