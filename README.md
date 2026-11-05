# Caboose 🚃

Run coding agents (Claude Code, GitHub Copilot) side by side, each in its own
git worktree.
macOS, Windows and Linux, run straight from a clone.

## Prerequisites

- Node 22.12+ (developed on Node 26) and npm
- git (on Windows: Git for Windows, which Claude Code needs too)
- Claude Code, logged in (`claude` then `/login`), for Claude chats
- A GitHub Copilot plan and `gh auth login`, for Copilot chats (optional)
- `gh`, logged in (`gh auth login`), for PRs

## Run

```sh
npm install
npm start          # build and run
npm run dev        # with hot reload
npm test           # core tests against real git repos
npm run typecheck
npm run spike      # checks the Agent SDK runs under your Claude login
```

Optional: copy `caboose.local.example.json` to `caboose.local.json` (gitignored)
for this machine's settings.

In a repo you add to Caboose, an optional `caboose.json` sets its scripts:

```json
{ "setup": "npm install", "run": "PORT=$CABOOSE_PORT npm run dev", "archive": "", "copy": [".env"] }
```

Scripts run through bash on every OS (Git Bash on Windows). They get
`CABOOSE_PORT` (the first of 10 ports reserved for the workspace),
`CABOOSE_WORKSPACE_NAME`, `CABOOSE_WORKSPACE_PATH`, `CABOOSE_ROOT_PATH` and
`CABOOSE_BRANCH`.

To check UI changes end to end, start the app with
`npx electron . --remote-debugging-port=9333` and drive it with
`node scripts/drive.ts 9333 steps.json` (see the top of that file).

## Shortcuts

Cmd on macOS, Ctrl on Windows/Linux.

| | |
| --- | --- |
| New workspace / chat tab / terminal | N / T / Shift+T |
| Chat / Changes | 1 / 2 |
| Toggle terminal | J |
| Focus the message box | L |
| Next / previous chat tab | Shift+] / Shift+[ |
| Next / previous workspace | Alt+Down / Alt+Up |
| Run (or restart) the run script | R |
| Stop Claude | . (or Esc in the message box) |
| Settings | , |

Settings also checks this machine's prerequisites and updates Caboose
(`git pull`, install, build, restart).

See `docs/PLAN.md` and `docs/DECISIONS.md`.
