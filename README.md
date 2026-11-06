# Caboose 🚃

Run coding agents (Claude Code, GitHub Copilot) side by side, each in its own
git worktree.
macOS, Windows and Linux, run straight from a clone.

## Prerequisites

- Node 22.12+ (developed on Node 26) and npm
- git (on Windows: Git for Windows, which Claude Code needs too)
- One of the two agents, logged in (Configure → Main agent picks which one
  new chats use; both can be used side by side):
  - **Claude Code**: a Claude subscription or API key; log in once with
    `/login` in Claude Code (the copy that comes with Caboose works:
    `node_modules/@anthropic-ai/claude-agent-sdk-<os>-<arch>/claude`).
  - **GitHub Copilot**: a Copilot plan and `gh auth login`.
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

The first launch opens the **Configure** screen: pick where features go, add
your repositories, and optionally connect Jira. It writes `caboose.local.json`
(gitignored; see `caboose.local.example.json`). "⚙ Configure" opens it again.

Configure can **import your repos from Conductor** (with their copy rules,
scripts and your create-PR prompt). Each repo has **scripts** (setup, named run
scripts, archive), and **local files** rules: the gitignored files a new
feature copies from the repo's main checkout so it can run (defaults `.env*`
and `*.local.*`; .gitignore-style patterns, with a live preview).

The **Board** shows every feature at a glance (a dot per repo, badges only
for what needs you); a feature's repo rows are one line each with the action
that matters now, and its **Pull requests** and **Activity** tabs gather every
PR and every chat in one place.

**New feature** is one optional text box: press Enter for an empty feature,
or describe the work and the feature's agent proposes which repos to add
(you confirm, correct or decline).

Each feature has a **central chat** (in the feature folder, seeing every repo)
and can **break out a chat per repo** (in that repo's worktree) when some repos
need focused follow-up; the central chat can do that itself and follow up. The
**Plan** tab holds the feature's plain-file brief, plan (checklist), per-repo
briefs and log; agents report their status there, and your notes go to the
chats they are for.

A **feature** gets a railway-station name and a folder with a git worktree for
each repo you pick (`<features folder>/<station>/<repo>/`). The agents work in
the feature folder and see all of its repos. With Jira on, a feature can be
tied to a task (`jira.txt` in its folder) and each repo to a subtask.

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
