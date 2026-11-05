// Checks the prerequisites on this machine, for the Settings page.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DoctorCheck } from "../../shared/types.ts";
import { run } from "./run.ts";
import { findBash } from "./scripts.ts";

const first = (s: string) => s.trim().split(/\r?\n/)[0];

export async function doctor(opts: { bashPath?: string; claudeAccount: () => Promise<string> }): Promise<DoctorCheck[]> {
  const check = async (name: string, fn: () => Promise<string>, hint: string): Promise<DoctorCheck> => {
    try {
      return { name, ok: true, detail: await fn() };
    } catch (e) {
      return { name, ok: false, detail: first((e as Error).message), hint };
    }
  };
  return Promise.all([
    check("git", async () => first(await run("git", ["--version"])), "Install git (on Windows: Git for Windows)."),
    check(
      "bash",
      async () => {
        const bash = await findBash(opts.bashPath);
        return `${bash}: ${first(await run(bash, ["--version"]))}`;
      },
      "Install Git for Windows, or set bashPath below.",
    ),
    check(
      "Claude Code",
      async () => `${claudeCodeVersion()} (bundled with the Agent SDK) · ${await opts.claudeAccount()}`,
      "Run `claude` in a terminal and log in with /login.",
    ),
    check("GitHub CLI", async () => first(await run("gh", ["--version"])), "Install gh from https://cli.github.com."),
    check(
      "GitHub login",
      async () => {
        const out = await run("gh", ["auth", "status"]);
        return first(out.split(/\r?\n/).find((l) => /Logged in/.test(l)) ?? "logged in").replace(/^[\s✓-]+/, "");
      },
      "Run `gh auth login`.",
    ),
    check("Node.js (in Electron)", async () => `${process.versions.node} · Electron ${process.versions.electron ?? "–"}`, ""),
  ]);
}

export function claudeCodeVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    // The package's exports hide package.json, so find it next to the entry point.
    const pkg = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).claudeCodeVersion ?? "unknown";
  } catch {
    return "unknown";
  }
}
