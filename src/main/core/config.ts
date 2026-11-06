// This machine's config (caboose.local.json in the Caboose checkout,
// gitignored) and each repo's caboose.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ConfigInput, ConfigView, JiraConfig, LocalConfig, RepoConfig, RepoEntry, Secret } from "../../shared/types.ts";

/** Encrypts secrets for the config file (Electron's safeStorage in the app). */
export type SecretCodec = { canEncrypt: boolean; encrypt(s: string): string; decrypt(s: string): string };
export const plainCodec: SecretCodec = { canEncrypt: false, encrypt: (s) => s, decrypt: (s) => s };

const FILE = "caboose.local.json";

function readJson<T>(file: string): T {
  if (!existsSync(file)) return {} as T;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch (e) {
    throw new Error(`${file} is not valid JSON: ${(e as Error).message}`);
  }
}

export type ResolvedLocalConfig = {
  featuresRoot: string;
  branchPrefix: string;
  repos: RepoEntry[];
  jira: JiraConfig;
  bashPath?: string;
  shellPath?: string;
  terminalFont?: string;
  prInstructions?: string;
  monikersFile?: string;
  openWith?: LocalConfig["openWith"];
  defaultAgent: "claude" | "copilot";
  defaultMode: NonNullable<LocalConfig["defaultMode"]>;
};

export const configFile = (cabooseDir: string) => join(cabooseDir, FILE);
export const configExists = (cabooseDir: string) => existsSync(configFile(cabooseDir));

/** The config as written, without defaults. */
export function readLocalConfig(cabooseDir: string): LocalConfig {
  return readJson<LocalConfig>(configFile(cabooseDir));
}

export function defaultFeaturesRoot(): string {
  return join(homedir(), "caboose", "features");
}

/** The config with defaults filled in. */
export function loadLocalConfig(cabooseDir: string): ResolvedLocalConfig {
  const c = readLocalConfig(cabooseDir);
  return {
    featuresRoot: c.featuresRoot ? expandHome(c.featuresRoot) : defaultFeaturesRoot(),
    branchPrefix: c.branchPrefix ?? "caboose",
    repos: (c.repos ?? []).map((r) => ({ ...r, path: expandHome(r.path) })),
    jira: { level: "off", ...c.jira },
    bashPath: c.bashPath,
    shellPath: c.shellPath,
    terminalFont: c.terminalFont,
    prInstructions: c.prInstructions,
    monikersFile: c.monikersFile ? expandHome(c.monikersFile) : undefined,
    defaultAgent: c.defaultAgent ?? "claude",
    defaultMode: c.defaultMode ?? "bypassPermissions",
    openWith: c.openWith,
  };
}

/** What the window may see: never the token itself. */
export function configView(c: LocalConfig): ConfigView {
  const { jira, ...rest } = c;
  if (!jira) return rest;
  const { token, ...j } = jira;
  return { ...rest, jira: { ...j, hasToken: Boolean(token) } };
}

/** Merges what the window saved into the stored config, encrypting a new token. */
export function applyConfigInput(stored: LocalConfig, input: ConfigInput, codec: SecretCodec): LocalConfig {
  const { jira, ...rest } = input;
  const out: LocalConfig = cleanStrings(rest);
  if (jira) {
    const { token, ...j } = jira;
    const kept = token === undefined ? stored.jira?.token : token === null || token.trim() === "" ? undefined : seal(token.trim(), codec);
    out.jira = { ...cleanStrings(j), level: j.level, ...(kept ? { token: kept } : {}) };
  }
  if (out.repos) {
    out.repos = out.repos
      .filter((r) => r.name && r.path)
      .map((r) => (r.localFiles ? { ...r, localFiles: r.localFiles.map((p) => p.trim()).filter(Boolean) } : r));
  }
  return out;
}

export function saveLocalConfig(cabooseDir: string, c: LocalConfig): void {
  writeFileSync(configFile(cabooseDir), `${JSON.stringify(c, null, 2)}\n`);
}

export function jiraToken(jira: JiraConfig, codec: SecretCodec): string | undefined {
  const t = jira.token;
  if (!t) return undefined;
  return "enc" in t ? codec.decrypt(t.enc) : t.plain;
}

function seal(secret: string, codec: SecretCodec): Secret {
  return codec.canEncrypt ? { enc: codec.encrypt(secret) } : { plain: secret };
}

/** Drops empty strings so defaults apply; keeps other values as they are. */
function cleanStrings<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o)
      .filter(([, v]) => !(typeof v === "string" && v.trim() === "") && v !== undefined)
      .map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]),
  ) as T;
}

/** A repo's `caboose.json`, read from its main checkout. */
export function loadRepoConfig(repoPath: string): RepoConfig {
  return readJson<RepoConfig>(join(repoPath, "caboose.json"));
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
}
