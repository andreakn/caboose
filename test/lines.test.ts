// Lines: optional groups of repos, so a feature only spans one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyConfigInput, plainCodec } from "../src/main/core/config.ts";
import { linesOf, reposFor, servesLine } from "../src/shared/lines.ts";

test("lines come from the repos on them; repos on no line serve every line", () => {
  const repos = [{ name: "web", line: "Varner" }, { name: "tools" }, { name: "blog", line: "Personal" }, { name: "cda", line: "Varner" }];
  assert.deepEqual(linesOf(repos), ["Personal", "Varner"]);
  assert.deepEqual(linesOf(repos.filter((r) => !r.line)), [], "no lines: the concept stays out of sight");
  assert.deepEqual(reposFor(repos, "Varner").map((r) => r.name), ["web", "tools", "cda"]);
  assert.deepEqual(reposFor(repos, undefined).map((r) => r.name), ["web", "tools", "blog", "cda"]);
  assert.ok(servesLine({}, "Varner") && !servesLine({ line: "Personal" }, "Varner"));
});

test("a repo's line is saved trimmed, and dropped when empty", () => {
  const c = applyConfigInput({}, { repos: [{ name: "web", path: "/w", line: " Varner " }, { name: "api", path: "/a", line: " " }] }, plainCodec);
  assert.deepEqual(c.repos, [{ name: "web", path: "/w", line: "Varner" }, { name: "api", path: "/a" }]);
});
