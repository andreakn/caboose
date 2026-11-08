// The program tools agents use to check their work runs: start (waiting for it to answer), fetch, stop.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Comments } from "../src/main/core/comments.ts";
import { cabooseHandlers } from "../src/main/core/mcp.ts";
import { Runner } from "../src/main/core/runner.ts";
import { Store } from "../src/main/core/store.ts";
import { Terminals } from "../src/main/core/terminals.ts";
import type { Feature } from "../src/shared/types.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "caboose-prog-")));
const terms = new Terminals({ onData: () => {}, onChange: () => {} });
after(() => {
  terms.closeAll();
  // Windows: the console host can hold the folder a moment after its shell has gone.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const port = 47000 + Math.floor(Math.random() * 900);
const web = join(dir, "oslo", "web");
mkdirSync(web, { recursive: true });
writeFileSync(join(web, "server.js"), `require("http").createServer((q, r) => r.end(q.url === "/health" ? "ok" : "hello")).listen(${port}, "127.0.0.1", () => console.log("up on ${port}"));\n`);
writeFileSync(join(web, "run_web.sh"), `#!/bin/bash\n# url: http://localhost:${port}/health\nsleep 1\nexec node server.js\n`);
writeFileSync(join(web, "run_broken.sh"), "echo 'boom: missing config' >&2; exit 3\n");
const f = { id: "f", name: "oslo", folder: join(dir, "oslo"), port: 41000, createdAt: "", archived: false, repos: [{ name: "web", source: web, path: web, branch: "b", baseRef: "main", setup: "none", copied: [] }] } as Feature;
const runner = new Runner({ terminals: terms, features: () => [f], repos: () => [], scriptsFor: () => ({}), scriptEnv: () => ({}), monikersFile: () => undefined, system: async () => ({ procs: new Map(), ports: new Map() }) });
const h = cabooseHandlers(() => f, new Comments(new Store(join(dir, "s.json"))), terms, { runner });

test("start waits until the program answers, fetch reaches it, stop ends it", async () => {
  assert.match(await h.listPrograms({}), /web:\n- broken \(run_broken\.sh\): stopped[\s\S]*- web \(run_web\.sh\): stopped; urls http:\/\/localhost:\d+\/health/);
  const started = await h.startProgram({ program: "web", wait: 20 });
  assert.match(started, /web is running in the user's Run tab[\s\S]*\/health answers 200/);
  assert.match(await h.fetchLocal({ url: `http://localhost:${port}/health` }), /^200 OK[\s\S]*\n\nok$/);
  assert.match(await h.fetchLocal({ url: "https://example.com/" }), /only reaches programs on this machine/);
  assert.match(await h.listPrograms({ repo: "web" }), /web \(run_web\.sh\): running/);
  assert.match(await h.stopProgram({ program: "web" }), /Stopped web/);
  assert.match(await h.fetchLocal({ url: `http://localhost:${port}/health` }), /No answer/);
});

test("a program that falls over says so, with its output", async () => {
  const r = await h.startProgram({ program: "broken", wait: 10 });
  assert.match(r, /broken exited with code 3[\s\S]*boom: missing config/);
  assert.match(await h.startProgram({ program: "nope" }), /has no program "nope"\. It has: broken, web/);
});
