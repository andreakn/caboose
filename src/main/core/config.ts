// This machine's config (caboose.local.json in the Caboose checkout,
// gitignored) and each repo's caboose.json.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mainLineFile } from "./mainline.ts";
import type { ConfigInput, ConfigView, HomeArea, JiraConfig, JiraInput, JiraView, LineSettings, LocalConfig, RepoConfig, RepoEntry, Secret } from "../../shared/types.ts";

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
  archiveRoot: string;
  branchPrefix: string;
  repos: RepoEntry[];
  jira: JiraConfig;
  bashPath?: string;
  shellPath?: string;
  terminalFont?: string;
  prInstructions?: string;
  monikersFile?: string;
  releaseStages?: LocalConfig["releaseStages"];
  openWith?: LocalConfig["openWith"];
  defaultAgent: "claude" | "copilot";
  defaultMode: NonNullable<LocalConfig["defaultMode"]>;
  home?: HomeArea;
  /** Lines' own settings, paths expanded. */
  lines: Record<string, LineSettings>;
};

/** The settings a feature on `line` works with: the line's own where it has them, else the general ones. */
export type Effective = Pick<ResolvedLocalConfig, "jira" | "featuresRoot" | "archiveRoot" | "branchPrefix" | "prInstructions" | "releaseStages">;

export function forLine(c: ResolvedLocalConfig, line?: string): Effective {
  const own = (line && c.lines[line]) || {};
  return {
    jira: own.jira ?? c.jira,
    featuresRoot: own.featuresRoot ?? c.featuresRoot,
    archiveRoot: own.archiveRoot ?? c.archiveRoot,
    branchPrefix: own.branchPrefix ?? c.branchPrefix,
    prInstructions: own.prInstructions ?? c.prInstructions,
    releaseStages: own.releaseStages ?? c.releaseStages,
  };
}

/** Every folder features can be in (the general one and the lines'). */
export const featureRoots = (c: ResolvedLocalConfig) => [...new Set([c.featuresRoot, ...Object.values(c.lines).flatMap((l) => (l.featuresRoot ? [l.featuresRoot] : []))])];

export const configFile = (cabooseDir: string) => join(cabooseDir, FILE);
export const configExists = (cabooseDir: string) => existsSync(configFile(cabooseDir));

/** The config as written, without defaults. */
export function readLocalConfig(cabooseDir: string): LocalConfig {
  return readJson<LocalConfig>(configFile(cabooseDir));
}

export function defaultFeaturesRoot(): string {
  return join(homedir(), "caboose", "features");
}

export function defaultArchiveRoot(): string {
  return join(homedir(), "caboose", "archive");
}

/** The config with defaults filled in. */
export function loadLocalConfig(cabooseDir: string): ResolvedLocalConfig {
  const c = readLocalConfig(cabooseDir);
  return {
    featuresRoot: c.featuresRoot ? expandHome(c.featuresRoot) : defaultFeaturesRoot(),
    archiveRoot: c.archiveRoot ? expandHome(c.archiveRoot) : defaultArchiveRoot(),
    branchPrefix: c.branchPrefix ?? "caboose",
    repos: (c.repos ?? []).map((r) => ({ ...r, path: expandHome(r.path) })),
    jira: { level: "off", ...c.jira },
    bashPath: c.bashPath,
    shellPath: c.shellPath,
    terminalFont: c.terminalFont,
    prInstructions: c.prInstructions,
    monikersFile: c.monikersFile ? expandHome(c.monikersFile) : undefined,
    releaseStages: c.releaseStages,
    defaultAgent: c.defaultAgent ?? "claude",
    defaultMode: c.defaultMode ?? "bypassPermissions",
    openWith: c.openWith,
    home: homeArea(c.home),
    lines: Object.fromEntries(
      Object.entries(c.lines ?? {}).map(([name, l]) => [
        name,
        {
          ...l,
          ...(l.featuresRoot ? { featuresRoot: expandHome(l.featuresRoot) } : {}),
          ...(l.archiveRoot ? { archiveRoot: expandHome(l.archiveRoot) } : {}),
          ...(l.jira ? { jira: { ...l.jira, level: l.jira.level ?? "off" } } : {}),
        },
      ]),
    ),
  };
}

/** A home area that is a real point in the Nordics, or nothing. */
export function homeArea(h: unknown): HomeArea | undefined {
  const { lon, lat } = (h ?? {}) as Partial<HomeArea>;
  if (typeof lon !== "number" || typeof lat !== "number" || !Number.isFinite(lon) || !Number.isFinite(lat)) return undefined;
  if (lon < 0 || lon > 35 || lat < 53 || lat > 72) return undefined;
  return { lon: Math.round(lon * 1000) / 1000, lat: Math.round(lat * 1000) / 1000 };
}

/** What the window may see: never the token itself. */
export function configView(c: LocalConfig): ConfigView {
  const { jira, lines, ...rest } = c;
  const view = (j: JiraConfig): JiraView => {
    const { token, ...v } = j;
    return { ...v, hasToken: Boolean(token) };
  };
  return {
    ...rest,
    ...(jira ? { jira: view(jira) } : {}),
    ...(lines ? { lines: Object.fromEntries(Object.entries(lines).map(([n, l]) => [n, l.jira ? { ...l, jira: view(l.jira) } : (l as Omit<LineSettings, "jira">)])) } : {}),
  };
}

/** A Jira setup as saved: a new token sealed, no token kept as it was, null or "" removes it. */
function jiraOf(input: JiraInput, stored: JiraConfig | undefined, codec: SecretCodec): JiraConfig {
  const { token, hasToken: _h, ...j } = input;
  const kept = token === undefined ? stored?.token : token === null || token.trim() === "" ? undefined : seal(token.trim(), codec);
  return { ...cleanStrings(j), level: j.level, ...(kept ? { token: kept } : {}) };
}

/** Merges what the window saved into the stored config, encrypting a new token. */
export function applyConfigInput(stored: LocalConfig, input: ConfigInput, codec: SecretCodec): LocalConfig {
  const { jira, lines, ...rest } = input;
  const out: LocalConfig = cleanStrings(rest);
  if (jira) out.jira = jiraOf(jira, stored.jira, codec);
  if (lines) {
    const saved: Record<string, LineSettings> = {};
    for (const [rawName, l] of Object.entries(lines)) {
      const name = rawName.trim();
      if (!name) continue;
      const { jira: lj, renamedFrom, releaseStages, ...plain } = l;
      const settings: LineSettings = {
        ...cleanStrings(plain),
        ...(releaseStages ? { releaseStages } : {}),
        ...(lj ? { jira: jiraOf(lj, stored.lines?.[renamedFrom ?? rawName]?.jira, codec) } : {}),
      };
      if (Object.keys(settings).length) saved[name] = settings;
    }
    if (Object.keys(saved).length) out.lines = saved;
    else delete out.lines;
  }
  if ("home" in out) {
    const home = homeArea(out.home);
    if (home) out.home = home;
    else delete out.home;
  }
  if (out.repos) {
    out.repos = out.repos
      .filter((r) => r.name && r.path)
      .map((r) => {
        const { label, line, ...rest } = r;
        const out: RepoEntry = { ...rest, ...(label?.trim() ? { label: label.trim() } : {}), ...(line?.trim() ? { line: line.trim() } : {}) };
        return out.localFiles ? { ...out, localFiles: out.localFiles.map((p) => p.trim()).filter(Boolean) } : out;
      });
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

/** The folder in a repo where Caboose's files can live, to keep the repo's root tidy. */
export const REPO_DIR = ".caboose";

/**
 * A repo's own config: `.caboose/config.json`, else `caboose.json` at its
 * root, as on the repo's main line (origin's default branch); where origin
 * has neither, the main checkout's copy.
 */
export function loadRepoConfig(repoPath: string): RepoConfig {
  const fromMain = mainLineFile(repoPath, `${REPO_DIR}/config.json`) ?? mainLineFile(repoPath, "caboose.json");
  if (fromMain !== null) return parseJson<RepoConfig>(fromMain, `${repoPath} (main line)`);
  const inDir = join(repoPath, REPO_DIR, "config.json");
  return readJson<RepoConfig>(existsSync(inDir) ? inDir : join(repoPath, "caboose.json"));
}

function parseJson<T>(text: string, where: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${where}: not valid JSON: ${(e as Error).message}`);
  }
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") || p.startsWith("~\\") ? join(homedir(), p.slice(1)) : p;
}
