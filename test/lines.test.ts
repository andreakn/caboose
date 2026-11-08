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
