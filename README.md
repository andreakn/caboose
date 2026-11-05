# Caboose 🚃

Run Claude Code agents side by side, each in its own git worktree.
macOS, Windows and Linux, run straight from a clone.

## Prerequisites

- Node 22.12+ (developed on Node 26) and npm
- git (on Windows: Git for Windows, which Claude Code needs too)
- Claude Code, logged in (`claude` then `/login`)
- `gh`, logged in (from Phase 7)

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
{ "setup": "npm install", "run": "npm run dev", "archive": "", "copy": [".env"] }
```

See `docs/PLAN.md` and `docs/DECISIONS.md`.
