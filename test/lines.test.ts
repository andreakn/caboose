// Lines: optional groups of repos, so a feature only spans one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyConfigInput, plainCodec } from "../src/main/core/config.ts";
import { linesOf, reposFor, servesLine } from "../src/shared/lines.ts";

test("lines come from the repos on them; repos on no line serve every line", () => {
  const repos = [{ name: "web", line: "Acme" }, { name: "tools" }, { name: "blog", line: "Personal" }, { name: "reports", line: "Acme" }];
  assert.deepEqual(linesOf(repos), ["Acme", "Personal"]);
  assert.deepEqual(linesOf(repos.filter((r) => !r.line)), [], "no lines: the concept stays out of sight");
  assert.deepEqual(reposFor(repos, "Acme").map((r) => r.name), ["web", "tools", "reports"]);
  assert.deepEqual(reposFor(repos, undefined).map((r) => r.name), ["web", "tools", "blog", "reports"]);
  assert.ok(servesLine({}, "Acme") && !servesLine({ line: "Personal" }, "Acme"));
});

test("a repo's line is saved trimmed, and dropped when empty", () => {
  const c = applyConfigInput({}, { repos: [{ name: "web", path: "/w", line: " Acme " }, { name: "api", path: "/a", line: " " }] }, plainCodec);
  assert.deepEqual(c.repos, [{ name: "web", path: "/w", line: "Acme" }, { name: "api", path: "/a" }]);
});

test("a line's own settings win, the general ones fill in; its own Jira is a whole other Jira", async () => {
  const { forLine, featureRoots, configView } = await import("../src/main/core/config.ts");
  const base = {
    featuresRoot: "/f",
    archiveRoot: "/a",
    branchPrefix: "caboose",
    repos: [],
    jira: { level: "required" as const, site: "https://ours.atlassian.net", email: "me@ours", project: "OUR" },
    prInstructions: "Short titles.",
    defaultAgent: "claude" as const,
    defaultMode: "bypassPermissions" as const,
    lines: { Acme: { featuresRoot: "/acme/f", branchPrefix: "feature", jira: { level: "optional" as const, site: "https://acme.atlassian.net" } }, Quiet: { jira: { level: "off" as const } } },
  };
  const acme = forLine(base, "Acme");
  assert.equal(acme.featuresRoot, "/acme/f");
  assert.equal(acme.archiveRoot, "/a", "not set for the line: the general one");
  assert.equal(acme.branchPrefix, "feature");
  assert.deepEqual(acme.jira, { level: "optional", site: "https://acme.atlassian.net" }, "nothing of the general Jira leaks in");
  assert.equal(acme.prInstructions, "Short titles.");
  assert.equal(forLine(base, "Quiet").jira.level, "off");
  assert.deepEqual(forLine(base, undefined), forLine(base, "Unknown"));
  assert.deepEqual(featureRoots(base), ["/f", "/acme/f"]);

  // Tokens: sealed, never shown, and kept when the line is renamed.
  const sealed = { canEncrypt: true, encrypt: (s: string) => `E(${s})`, decrypt: (s: string) => s.slice(2, -1) };
  let stored = applyConfigInput({}, { lines: { Acme: { jira: { level: "optional", site: "https://acme.atlassian.net", token: "secret" }, branchPrefix: " " } } }, sealed);
  assert.deepEqual(stored.lines, { Acme: { jira: { level: "optional", site: "https://acme.atlassian.net", token: { enc: "E(secret)" } } } }, "empty settings are dropped");
  const view = configView(stored);
  assert.deepEqual(view.lines?.Acme.jira, { level: "optional", site: "https://acme.atlassian.net", hasToken: true });
  stored = applyConfigInput(stored, { ...view, lines: { Customer: { ...view.lines!.Acme, renamedFrom: "Acme" } } }, sealed);
  assert.deepEqual(stored.lines?.Customer.jira?.token, { enc: "E(secret)" }, "the token follows the rename");
  assert.equal(stored.lines?.Acme, undefined);
  assert.equal("hasToken" in (stored.lines?.Customer.jira ?? {}), false);
  assert.equal(applyConfigInput(stored, { lines: { Customer: {} } }, sealed).lines, undefined, "a line with nothing of its own is not saved");
});
