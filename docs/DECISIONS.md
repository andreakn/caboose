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
   `<prefix>/<station>` (prefix = OS user name by default), branched from
   `origin/HEAD` (else the current branch) after a `git fetch` that is allowed
   to fail offline. The branch is created **without** upstream tracking so a
   plain `git push` can never push to main.
6. **Names are railway stations**, Norwegian first (finse, myrdal, flam…).
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

## Questions for Andreas

- **GitHub repo?** Nothing is pushed anywhere yet. Create a private
  `andreakn/caboose` and push? (Needed before you can clone on Windows.)
- **Branch prefix**: OS user name (`andreakn/finse`) OK, or `caboose/finse`?
- **Stations**: fun, or would you rather have Conductor-style city names?
- **Linux**: nothing so far is Mac/Windows-only, but it is untested.
