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

A sound (Configure → Sounds) plays when an agent is done or needs you.

The **Board** shows every feature at a glance (a dot per repo, badges only
for what needs you); a feature's repo rows are one line each with the action
that matters now, and its **Pull requests** and **Activity** tabs gather every
PR and every chat in one place.

A feature page has two levels: **Feature** (the repos at a glance, the
central chat, plan, programs, PRs, activity) and a tab per **repo** (its
files as a navigable tree, its changes, its own chats and programs).

**New feature** is one optional text box: press Enter for an empty feature,
or describe the work and the feature's agent proposes which repos to add
(you confirm, correct or decline).

Each feature has a **central chat** (in the feature folder, seeing every repo)
and can **break out a chat per repo** (in that repo's worktree) when some repos
need focused follow-up; the central chat can do that itself and follow up. The
**Plan** tab holds the feature's plain-file brief, plan (checklist), per-repo
briefs and log; agents report their status there, and your notes go to the
chats they are for.

**Archive…** on a feature closes its open PRs and deletes its branches
(here and on GitHub), then either moves its folder and chat logs to the
archive folder (`<archive>/yyyy-mm-dd_hh-mm_<station>/`) or deletes them.
It shows first what would be lost.

A **feature** gets a railway-station name and a folder with a git worktree for
each repo you pick (`<features folder>/<station>/<repo>/`). The agents work in
the feature folder and see all of its repos. With Jira on, a feature can be
tied to a task (`jira.txt` in its folder) and each repo to a subtask.

In a repo you add to Caboose, an optional `.caboose/config.json` (or
`caboose.json` at the root) sets its scripts:

```json
{ "setup": "npm install", "run": "PORT=$CABOOSE_PORT npm run dev", "archive": "", "copy": [".env"] }
```

The **Run** tab lists every repo's programs: `run.sh` and `run_<moniker>.sh`
at the root of its worktree or in its `.caboose/` folder (they run from the
root either way; the root's wins if both have one), plus the run
scripts from Configure / `caboose.json`. ▶ starts one in a terminal tab, ■
stops it (Ctrl-C, then a hang-up after 10 s), ↻ runs one that exited again;
"▶ all" per repo, "▶ Run feature" (Cmd/Ctrl+R) and "■ Stop all" for the lot.
A script that serves a website declares its URL for a 🌐 button:
`# url: http://localhost:15081/customer-data-api/ swagger` (or just a
localhost URL in its header comment). Programs listening from a worktree that
the Run tab did not start (by hand, by an agent, from an IDE) are flagged with
a stop button, as is whatever holds a port a script declares. An optional
**moniker file** (Configure → Terminals; `moniker path description` per line)
labels repos and their `run_<moniker>.sh`.

**Platforms: a feature in waves.** Some features ship in steps (contracts,
then data, then removing the old hacks), and sometimes what was merged and
deployed turns out wrong and needs a new revision. Once a feature's PRs are
merged (or closed), **＋ platform** in its header (or "Next platform…" on the
all-merged banner) starts its next platform: a goal, the repos (others from
the line can join, and repos can leave), and for Jira either new subtasks
for the platform or the same ones moved back to In Progress. Each repo gets
a new branch from its base (`…-p2`) in the same folder, so its chat carries
on; the station keeps its chats, log, to-dos and plan (`plan.md` gets a
section per platform), and the agents are told which platform they are on.
The earlier platform is kept (P1 in the header: its PRs and releases) and
followed to prod in the sidebar, unless you mark it superseded.

**Azure tenants.** Programs that sign in to Azure (az, AzureCliCredential) in
more than one tenant: list a line's tenants in Configure → Lines (a name, the
tenant id or domain, and optionally its store; default
`~/.azure-tenant-<name>`). Each tenant has its own Azure CLI store, so you can
be signed in to all of them at once. In the Run tab, each program picks its
tenant and starts with that store as `AZURE_CONFIG_DIR` (as does a repo
terminal whose programs all use one tenant). The Run tab also shows each
tenant's sign-in: signed in (as whom), expired (the account is there but az
can no longer get a token, e.g. after a conditional-access limit), or not
signed in, with a button that runs `az login --tenant …` into that store.

**What runs where.** A tag starts a deploy, but an approval step or pods that
will not start can keep new code from running. A repo can say what actually
runs with `.caboose/running.sh`, which prints one line per component (a
moniker; leave it out for a repo with one) and environment:

```
orders  test  orders_TEST_v1.437
orders  prod  orders_PROD_v1.430+build.12
```

A version starts with the git tag that made its release; Caboose finds that
tag and checks with git whether it has a feature's merge commit. A release
that is not tagged (every push to the main line deployed, versioned by its
short sha) can be reported by its commit instead: `carlings test 0acc5774`.
Components can be anything deployed on its own (services, or the same app per
brand or region), so a change that runs for some and not yet for others shows
as such. Each repo
shows what runs in each environment; once its PR is merged, ✓ where the change
runs. Where a repo has the script, a feature's deploy progress and
announcements count what runs, not just tags. Caboose runs the script as it
is on the repo's main line (origin's default branch, fetched now and then),
from the main checkout's folder, with your own credentials (kubectl, VPN), at
most every minute, giving up after 20 s; it does not need to know about
features. A feature that changes `running.sh` runs its own copy, so a new
script can be tried before it is merged. `.caboose/config.json` is read from
the main line too; where origin has none of these files yet, the main
checkout's copies are used. A feature
can say which components it touches (the picker behind the chips, or the
agent's SetComponents), and only those are shown and counted.

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
| Run every program of the feature (Run tab) | R |
| Stop Claude | . (or Esc in the message box) |
| Settings | , |

Settings also checks this machine's prerequisites and updates Caboose
(`git pull`, install, build, restart).

See `docs/PLAN.md` and `docs/DECISIONS.md`.
