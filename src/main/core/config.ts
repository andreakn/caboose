import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalConfig, RepoConfig } from "../../shared/types.ts";

function readJson<T>(file: string): T {
  if (!existsSync(file)) return {} as T;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export type ResolvedLocalConfig = Required<Omit<LocalConfig, "bashPath" | "shellPath" | "terminalFont">> & {
  bashPath?: string;
  shellPath?: string;
  terminalFont?: string;
};

/** This machine's settings: `caboose.local.json` in the Caboose checkout, with defaults. */
export function loadLocalConfig(cabooseDir: string): ResolvedLocalConfig {
  const c = readJson<LocalConfig>(join(cabooseDir, "caboose.local.json"));
  return {
    workspacesRoot: c.workspacesRoot ? expandHome(c.workspacesRoot) : join(homedir(), "caboose", "workspaces"),
    branchPrefix: c.branchPrefix ?? "caboose",
    bashPath: c.bashPath,
    shellPath: c.shellPath,
    terminalFont: c.terminalFont,
  };
}

/** A repo's `caboose.json`, read from its main checkout. */
export function loadRepoConfig(repoPath: string): RepoConfig {
  return readJson<RepoConfig>(join(repoPath, "caboose.json"));
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
}
