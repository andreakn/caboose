// Checks the prerequisites on this machine, for the Settings page.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DoctorCheck } from "../../shared/types.ts";
import { run } from "./run.ts";
import { findBash } from "./scripts.ts";

const first = (s: string) => s.trim().split(/\r?\n/)[0];

export async function doctor(opts: {
  bashPath?: string;
  claudeAccount: () => Promise<string>;
  copilotAccount: () => Promise<string>;
  /** The main agent: the other one is optional. */
  mainAgent?: "claude" | "copilot";
}): Promise<DoctorCheck[]> {
  const check = async (name: string, fn: () => Promise<string>, hint: string, optional = false): Promise<DoctorCheck> => {
    try {
      return { name, ok: true, detail: await fn() };
    } catch (e) {
      return { name, ok: false, detail: first((e as Error).message), hint, ...(optional ? { optional } : {}) };
    }
  };
  const main = opts.mainAgent ?? "claude";
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
      async () => `${claudeCodeVersion()} (comes with Caboose) · ${await opts.claudeAccount()}`,
      `${main === "copilot" ? "Optional: your main agent is Copilot. " : ""}Needs a Claude subscription or API key. Log in once in a terminal with Claude Code${claudeBinary() ? ` ("${claudeBinary()}", the copy that comes with Caboose, or your own \`claude\`)` : " (`claude`)"}, then /login.`,
      main === "copilot",
    ),
    check(
      "GitHub Copilot",
      async () => `${copilotVersion()} (comes with Caboose) · ${await opts.copilotAccount()}`,
      `${main === "claude" ? "Optional: your main agent is Claude. " : ""}Needs a Copilot plan. Log in with \`gh auth login\` (a classic ghp_ token in GH_TOKEN does not work for Copilot).`,
      main === "claude",
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

/** The Claude Code binary that comes with the Agent SDK for this OS, if found. */
export function claudeBinary(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const dir = dirname(require.resolve(`${pkg}/package.json`));
    const bin = join(dir, process.platform === "win32" ? "claude.exe" : "claude");
    return existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

export function copilotVersion(): string {
  return packageJson("@github/copilot-sdk")?.copilotCliVersion ?? "unknown";
}

export function claudeCodeVersion(): string {
  return packageJson("@anthropic-ai/claude-agent-sdk")?.claudeCodeVersion ?? "unknown";
}

/** A dependency's package.json, found by walking up from its entry point (exports hide it). */
function packageJson(name: string): Record<string, string> | undefined {
  try {
    let dir = dirname(createRequire(import.meta.url).resolve(name));
    for (let i = 0; i < 5; i++, dir = dirname(dir)) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        if (pkg.name === name) return pkg;
      } catch {
        // keep walking up
      }
    }
  } catch {
    // not installed
  }
  return undefined;
}
