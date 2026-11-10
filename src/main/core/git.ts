import { git } from "./run.ts";

/** The top of the work tree containing `path`, or null if it is not in a git repo. */
export async function repoRoot(path: string): Promise<string | null> {
  try {
    return await git(path, "rev-parse", "--show-toplevel");
  } catch {
    return null;
  }
}

export async function hasRemote(root: string, remote = "origin"): Promise<boolean> {
  const remotes = (await git(root, "remote")).split("\n");
  return remotes.includes(remote);
}

/** "origin/main" when there is an origin with a default branch, else the current local branch. */
export async function defaultBaseRef(root: string): Promise<string> {
  if (await hasRemote(root)) {
    try {
      return await git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    } catch {
      for (const b of ["main", "master"]) {
        if (await refExists(root, `refs/remotes/origin/${b}`)) return `origin/${b}`;
      }
    }
  }
  const current = await git(root, "branch", "--show-current");
  return current || "HEAD";
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
}

export const branchExists = (root: string, branch: string) => refExists(root, `refs/heads/${branch}`);

export async function fetchOrigin(root: string): Promise<void> {
  if (await hasRemote(root)) await git(root, "fetch", "origin", "--prune");
}

/** The repo's shared .git directory (the same for every worktree). */
export async function commonGitDir(root: string): Promise<string> {
  return git(root, "rev-parse", "--path-format=absolute", "--git-common-dir");
}

export async function addWorktree(root: string, path: string, branch: string, baseRef: string): Promise<void> {
  // --no-track: the new branch must not track origin/main, or `git push` would push to main.
  await git(root, "worktree", "add", "--no-track", "-b", branch, path, baseRef);
}

export async function addWorktreeForBranch(root: string, path: string, branch: string): Promise<void> {
  await git(root, "worktree", "add", path, branch);
}

export async function removeWorktree(root: string, path: string): Promise<void> {
  await git(root, "worktree", "remove", "--force", path);
  await git(root, "worktree", "prune");
}

/** Whether the checked-out branch has an upstream (has been pushed). */
export async function hasUpstream(path: string): Promise<boolean> {
  try {
    await git(path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}");
    return true;
  } catch {
    return false;
  }
}

export async function renameBranch(path: string, from: string, to: string): Promise<void> {
  await git(path, "check-ref-format", "--branch", to);
  await git(path, "branch", "-m", from, to);
}

/** A new branch from `baseRef` in an existing worktree; --no-track, as in addWorktree. */
export async function switchToNewBranch(path: string, branch: string, baseRef: string): Promise<void> {
  await git(path, "check-ref-format", "--branch", branch);
  await git(path, "switch", "--no-track", "-c", branch, baseRef);
}

export async function deleteBranch(root: string, branch: string): Promise<void> {
  await git(root, "branch", "-D", branch);
}
