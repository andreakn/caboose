// Azure sign-ins per tenant: each tenant's own store, and whether its sign-in still works.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type AzRun, AzureSignIns, azureState, configDirOf, validTenantId } from "../src/main/core/azure.ts";
import { applyConfigInput, azureTenantsOf, plainCodec } from "../src/main/core/config.ts";

const dir = mkdtempSync(join(tmpdir(), "caboose-azure-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const TECH = "178bdfda-3ad4-4375-a74a-dc96f80fbee7";
const ok = (stdout: string): AzRun => ({ code: 0, stdout, stderr: "" });
const err = (stderr: string): AzRun => ({ code: 1, stdout: "", stderr });
const show = ok(JSON.stringify({ user: { name: "me@example.com" }, tenantId: TECH, name: "Shared - Test" }));

test("a tenant's store: its own folder, else ~/.azure-tenant-<name>", () => {
  assert.equal(configDirOf({ name: "Ops", tenantId: "x" }), join(homedir(), ".azure-tenant-ops"));
  assert.equal(configDirOf({ name: "my tenant!", tenantId: "x" }), join(homedir(), ".azure-tenant-my-tenant"));
  assert.equal(configDirOf({ name: "ops", tenantId: "x", configDir: "~/.azure-tenant-shopops" }), join(homedir(), ".azure-tenant-shopops"));
  assert.ok(validTenantId(TECH) && validTenantId("contoso.onmicrosoft.com"));
  assert.ok(!validTenantId("x; rm -rf ~") && !validTenantId("--help") && !validTenantId(""));
});

test("signed in only when a token can be had; an account whose sign-in ran out is expired", () => {
  const t = { name: "tech", tenantId: TECH };
  assert.deepEqual(azureState(t, ok('{"expiresOn": "2026-11-10 13:39:00"}'), show), { state: "ok", user: "me@example.com", detail: "token valid until 2026-11-10 13:39:00" });
  // What az says when conditional access has capped the sign-in (the account is still there).
  const expired = azureState(
    t,
    err(
      "ERROR: AADSTS70043: The refresh token has expired or is invalid due to sign-in frequency checks by conditional access. The token was issued on 2026-11-09T07:07:53Z and the maximum allowed lifetime for this request is 28800. Trace ID: 808f Correlation ID: 897f\nRun the command below to authenticate interactively; additional arguments may be added as needed:\naz logout\naz login --tenant \"x\"",
    ),
    show,
  );
  assert.equal(expired.state, "expired");
  assert.equal(expired.user, "me@example.com");
  assert.match(expired.detail!, /^AADSTS70043: The refresh token has expired.*28800\.$/);
  assert.deepEqual(azureState(t, err("ERROR: Please run 'az login' to setup account."), err("ERROR: Please run 'az login' to setup account.")), { state: "none", detail: "Not signed in." });
  assert.equal(azureState(t, { code: 1, stdout: "", stderr: "", missing: true }, { code: 1, stdout: "", stderr: "", missing: true }).state, "no-cli");
  const other = azureState(t, ok("{}"), ok(JSON.stringify({ user: { name: "me@example.com" }, tenantId: "00000000-0000-0000-0000-000000000000" })));
  assert.equal(other.state, "error");
  assert.match(other.detail!, /another tenant/);
});

test("checks run az in the tenant's store, cached a minute; signing in uses the store and checks again", async () => {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  let signedIn = false;
  const signIns = new AzureSignIns(async (args, env) => {
    calls.push({ args, env });
    if (args[0] === "login") {
      signedIn = true;
      return ok("");
    }
    if (args[1] === "show") return signedIn ? show : err("ERROR: Please run 'az login' to setup account.");
    return signedIn ? ok('{"expiresOn": "soon"}') : err("ERROR: Please run 'az login' to setup account.");
  });
  const t = { name: "tech", tenantId: TECH, configDir: join(dir, "tech") };
  assert.equal((await signIns.status(t)).state, "none");
  assert.ok(existsSync(join(dir, "tech")), "the store is made");
  assert.ok(calls.every((c) => c.env.AZURE_CONFIG_DIR === join(dir, "tech")));
  assert.deepEqual(calls.find((c) => c.args[1] === "get-access-token")!.args.slice(0, 4), ["account", "get-access-token", "--tenant", TECH]);
  await signIns.status(t);
  assert.equal(calls.length, 2, "cached");
  const after = await signIns.login(t);
  assert.equal(after.state, "ok");
  assert.deepEqual(calls[2].args.slice(0, 3), ["login", "--tenant", TECH]);
  assert.equal(calls.length, 5, "checked again after signing in");
  await assert.rejects(signIns.login({ name: "bad", tenantId: "--use-device-code", configDir: join(dir, "bad") }), /not a tenant id/);
});

test("a line's tenants are saved trimmed, complete and once each", () => {
  assert.deepEqual(
    azureTenantsOf([
      { name: " ops ", tenantId: " abc ", configDir: " " },
      { name: "", tenantId: "x" },
      { name: "tech", tenantId: "" },
      { name: "ops", tenantId: "again" },
      { name: "tech", tenantId: TECH, configDir: "~/.azure-tenant-shoptech" },
    ]),
    [
      { name: "ops", tenantId: "abc" },
      { name: "tech", tenantId: TECH, configDir: "~/.azure-tenant-shoptech" },
    ],
  );
  const saved = applyConfigInput({}, { lines: { shop: { azureTenants: [{ name: "ops", tenantId: "abc" }] }, other: { azureTenants: [{ name: "", tenantId: "" }] } } }, plainCodec);
  assert.deepEqual(saved.lines, { shop: { azureTenants: [{ name: "ops", tenantId: "abc" }] } });
});
