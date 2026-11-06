import assert from "node:assert/strict";
import { test } from "node:test";
import { parseToml } from "../src/main/core/toml.ts";

test("reads Conductor's settings files", () => {
  const t = parseToml(`"$schema" = "https://conductor.build/schemas/settings.repo.schema.json"
file_include_globs = ".env\\n.env.local\\n**/appsettings.local.json\\n"  # trailing comment
archive_on_merge = true

[scripts]
setup = 'npm ci'
run_mode = "concurrent"

[scripts.run.dashboard]
available_in = [ "local", 'remote' ]
command = "node server.mjs"
default = true

[prompts]
create_pr = """
Line one
Line "two"
"""
[git]
branch_prefix = "BFF-"
port = 4_477
`);
  assert.equal(t.file_include_globs, ".env\n.env.local\n**/appsettings.local.json\n");
  assert.equal(t.archive_on_merge, true);
  assert.deepEqual(t.scripts, {
    setup: "npm ci",
    run_mode: "concurrent",
    run: { dashboard: { available_in: ["local", "remote"], command: "node server.mjs", default: true } },
  });
  assert.equal((t.prompts as Record<string, string>).create_pr, 'Line one\nLine "two"\n');
  assert.deepEqual(t.git, { branch_prefix: "BFF-", port: 4477 });
});
