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

## Answered (2026-11-05)

- Private GitHub repo `andreakn/caboose`: yes.
- Branch prefix: `caboose`.
- Names: railway stations from all the Nordic countries.
- Linux: tested later. Flag any choice that affects Linux compatibility.
