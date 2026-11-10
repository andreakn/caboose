// Azure sign-ins per tenant, for lines whose programs sign in to more than one
// Azure tenant. Each tenant gets its own Azure CLI store (AZURE_CONFIG_DIR,
// default ~/.azure-tenant-<name>), so signing in to one never signs out the
// other; a program started with a tenant's folder in AZURE_CONFIG_DIR (az,
// and AzureCliCredential in the services) uses that tenant's sign-in. This
// is what a shell script that sets AZURE_CONFIG_DIR before running a service
// does, done here so it works wherever Caboose runs.
//
// "Signed in" is not enough: a store keeps its account after the sign-in has
// run out (conditional access can cap it at 8 hours), and `az account show`
// still answers. So a store counts as signed in only when az can get a token
// from it.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AzureState, AzureStatus, AzureTenant } from "../../shared/types.ts";
import { expandHome } from "./config.ts";

const CHECK_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 20_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

/** A tenant id (GUID) or domain (contoso.onmicrosoft.com): nothing a shell could read as more. */
export const validTenantId = (id: string) => /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id);
const isGuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** The tenant's store: its configured folder, else ~/.azure-tenant-<name>. */
export function configDirOf(t: AzureTenant): string {
  if (t.configDir?.trim()) return expandHome(t.configDir.trim());
  const slug = t.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tenant";
  return join(homedir(), `.azure-tenant-${slug}`);
}

/** What a program needs to sign in with the tenant: its store, made if missing. */
export function azureEnv(t: AzureTenant): Record<string, string> {
  const dir = configDirOf(t);
  mkdirSync(dir, { recursive: true });
  return { AZURE_CONFIG_DIR: dir };
}

/** One az call's outcome; `missing` when az is not installed. */
export type AzRun = { code: number; stdout: string; stderr: string; missing?: boolean };
export type AzRunner = (args: string[], env: Record<string, string>, timeoutMs: number) => Promise<AzRun>;

/** Runs az (az.cmd on Windows, hence the shell there; the arguments are checked, never free text). */
export const runAz: AzRunner = (args, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "az",
      args,
      { env: { ...process.env, ...env }, timeout: timeoutMs, windowsHide: true, shell: process.platform === "win32", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const missing = e?.code === "ENOENT" || (process.platform === "win32" && /is not recognized as an internal or external command/i.test(String(stderr)));
        resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), ...(missing ? { missing } : {}) });
      },
    );
  });

/** The first line of az's complaint that says something (not "Run the command below…"). */
function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^ERROR:\s*/, "").trim())
    .find(Boolean);
  return (line ?? "").replace(/\s*Trace ID:.*$/, "").slice(0, 300);
}

/**
 * The state of a store from `az account get-access-token` (token) and
 * `az account show` (show): a token means signed in; an account without a
 * token means the sign-in ran out; neither means never signed in.
 */
export function azureState(t: AzureTenant, token: AzRun, show: AzRun): { state: AzureState; user?: string; detail?: string } {
  if (token.missing || show.missing) return { state: "no-cli", detail: "The Azure CLI (az) is not installed, or not on the PATH Caboose was started with." };
  let account: { user?: { name?: string }; tenantId?: string } | null = null;
  try {
    account = show.code === 0 ? JSON.parse(show.stdout) : null;
  } catch {
    account = null;
  }
  const user = account?.user?.name || undefined;
  const other = account?.tenantId && isGuid(t.tenantId) && account.tenantId.toLowerCase() !== t.tenantId.toLowerCase();
  if (token.code === 0) {
    if (other) return { state: "error", ...(user ? { user } : {}), detail: `Signed in to another tenant (${account!.tenantId}), not ${t.tenantId}.` };
    let expires: string | undefined;
    try {
      expires = JSON.parse(token.stdout)?.expiresOn;
    } catch {
      expires = undefined;
    }
    return { state: "ok", ...(user ? { user } : {}), ...(expires ? { detail: `token valid until ${expires}` } : {}) };
  }
  const why = firstLine(token.stderr || token.stdout);
  if (user) return { state: "expired", user, detail: why || "The sign-in has run out." };
  if (/az login/i.test(token.stderr + show.stderr)) return { state: "none", detail: "Not signed in." };
  return { state: "error", detail: why || `az exited with ${token.code}` };
}

/** Sign-in checks per store (a minute each: az is not free), and sign-ins. */
export class AzureSignIns {
  private cache = new Map<string, { at: number; value: Promise<AzureStatus> }>();
  private logins = new Map<string, Promise<AzureStatus>>();
  private az: AzRunner;

  constructor(az: AzRunner = runAz) {
    this.az = az;
  }

  private key = (t: AzureTenant) => `${configDirOf(t)}\0${t.tenantId}`;

  async check(t: AzureTenant): Promise<AzureStatus> {
    const configDir = configDirOf(t);
    const base = { tenant: t.name, tenantId: t.tenantId, configDir, checkedAt: new Date().toISOString() };
    if (!validTenantId(t.tenantId)) return { ...base, state: "error", detail: `"${t.tenantId}" is not a tenant id or domain.` };
    const env = azureEnv(t);
    const [token, show] = await Promise.all([
      this.az(["account", "get-access-token", "--tenant", t.tenantId, "--query", "{expiresOn:expiresOn}", "-o", "json"], env, CHECK_TIMEOUT_MS),
      this.az(["account", "show", "-o", "json"], env, CHECK_TIMEOUT_MS),
    ]);
    return { ...base, ...azureState(t, token, show) };
  }

  /** The tenant's status, from the last minute unless `fresh`. */
  status(t: AzureTenant, fresh = false): Promise<AzureStatus> {
    const key = this.key(t);
    const hit = this.cache.get(key);
    if (hit && !fresh && Date.now() - hit.at < CHECK_TTL_MS) return hit.value;
    const value = this.check(t);
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  /** az login --tenant, into the tenant's own store (the browser opens); then its status. One at a time per store. */
  login(t: AzureTenant): Promise<AzureStatus> {
    const key = this.key(t);
    const running = this.logins.get(key);
    if (running) return running;
    const p = (async () => {
      if (!validTenantId(t.tenantId)) throw new Error(`"${t.tenantId}" is not a tenant id or domain.`);
      const r = await this.az(["login", "--tenant", t.tenantId, "--only-show-errors", "-o", "none"], azureEnv(t), LOGIN_TIMEOUT_MS);
      if (r.missing) throw new Error("The Azure CLI (az) is not installed, or not on the PATH Caboose was started with.");
      if (r.code !== 0) throw new Error(firstLine(r.stderr || r.stdout) || `az login exited with ${r.code}`);
      return this.status(t, true);
    })().finally(() => this.logins.delete(key));
    this.logins.set(key, p);
    return p;
  }
}
