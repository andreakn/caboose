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

## Answered (2026-11-05)

- Private GitHub repo `andreakn/caboose`: yes.
- Branch prefix: `caboose`.
- Names: railway stations from all the Nordic countries.
- Linux: tested later. Flag any choice that affects Linux compatibility.
