// The Run tab: finding run scripts, their URLs and monikers, starting and
// stopping them, and programs listening from a worktree that it did not start.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listeners, parseLsof, parsePs, parseSs, type Proc, runsFrom } from "../src/main/core/listeners.ts";
import { Runner } from "../src/main/core/runner.ts";
import { declaredUrls, monikersOf, parseMonikers, runnables } from "../src/main/core/runscripts.ts";
import { Terminals } from "../src/main/core/terminals.ts";
import type { Feature } from "../src/shared/types.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "caboose-run-")));
const terms = new Terminals({ onData: () => {}, onChange: () => {} });
after(() => {
  terms.closeAll();
  rmSync(dir, { recursive: true, force: true });
});
const until = async (fn: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

test("URLs come from # url: lines, else localhost URLs in the header comment", () => {
  assert.deepEqual(declaredUrls("#!/bin/bash\n# url: http://localhost:15081/cda/ swagger\n# url: http://localhost:15081/health\nexec x"), [
    { url: "http://localhost:15081/cda/", label: "swagger" },
    { url: "http://localhost:15081/health" },
  ]);
  assert.deepEqual(declaredUrls("#!/bin/bash\n# Starts CDA locally on http://localhost:15081/customer-data-api/.\nset -e\n# not http://localhost:1/"), [
    { url: "http://localhost:15081/customer-data-api/" },
  ]);
  assert.deepEqual(declaredUrls("echo http://localhost:3000"), []);
});

test("run.sh and run_<moniker>.sh at the root, plus configured scripts that are not one of them", () => {
  const repo = join(dir, "api");
  mkdirSync(join(repo, "sub"), { recursive: true });
  writeFileSync(join(repo, "run.sh"), "#!/bin/bash\n# url: http://localhost:5173/ app\nnpm run dev\n");
  writeFileSync(join(repo, "run_ccws.sh"), "echo worker\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  writeFileSync(join(repo, "runner.sh"), "");
  writeFileSync(join(repo, "sub", "run_x.sh"), "");
  const list = runnables(repo, [
    { name: "dev", command: "./run.sh" },
    { name: "test", command: "npm test" },
  ]);
  assert.deepEqual(
    list.map((x) => [x.id, x.label, x.command]),
    [
      ["run.sh", "run", "./run.sh"],
      ["run_ccws.sh", "ccws", "bash run_ccws.sh"],
      ["config:test", "test", "npm test"],
    ],
  );
  assert.deepEqual(list[0].urls, [{ url: "http://localhost:5173/", label: "app" }]);
  assert.deepEqual(runnables(join(dir, "missing")), []);
});

test("monikers name repos and describe their run scripts", () => {
  const entries = parseMonikers("# comment\ncds  cust-sync   CDS: the sync workers\nccws cust-sync CDS: customer cleanup worker (run_ccws.sh)\ncda ./cust-cda\n", "/home/me/varner");
  const m = monikersOf(entries, "/home/me/varner/cust-sync/");
  assert.equal(m.moniker, "cds");
  assert.equal(m.description, "CDS: the sync workers");
  assert.equal(m.describe("CCWS"), "CDS: customer cleanup worker (run_ccws.sh)");
  assert.equal(m.describe(undefined), "CDS: the sync workers", "run.sh is the repo's own program");
  assert.equal(monikersOf(entries, "/home/me/varner/cust-cda").moniker, "cda");
  assert.equal(monikersOf(entries, "/elsewhere").moniker, undefined);
});

test("ps, lsof and ss output", () => {
  assert.deepEqual([...parsePs("  10     1 /sbin/launchd\n 200    10 node /w/oslo/web/node_modules/.bin/vite --port 5173\n").values()][1], {
    pid: 200,
    ppid: 10,
    command: "node /w/oslo/web/node_modules/.bin/vite --port 5173",
  });
  assert.deepEqual(parseLsof("p200\nf20\nn127.0.0.1:5173\nn[::1]:5173\np300\nn*:8080\n"), new Map([[200, new Set([5173])], [300, new Set([8080])]]));
  assert.deepEqual(
    parseSs('LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=200,fd=21))\nLISTEN 0 4096 [::]:22 [::]:*\n'),
    new Map([[200, new Set([5173])]]),
  );
});

test("listeners: ours by ancestry, launchers up to a shell, never Caboose or its agents", () => {
  const p = (pid: number, ppid: number, command: string): [number, Proc] => [pid, { pid, ppid, command }];
  const procs = new Map([
    p(1, 0, "launchd"),
    p(50, 1, "/Applications/Caboose.app/Contents/MacOS/Caboose"),
    p(60, 50, "bash -lc ./run.sh"), // a Caboose terminal
    p(61, 60, "node /w/oslo/web/node_modules/.bin/vite"),
    p(70, 50, "claude --output-format stream-json"), // an agent
    p(71, 70, "npm run dev"),
    p(72, 71, "node /w/oslo/api/server.js"),
    p(80, 1, "-zsh"),
    p(81, 80, "dotnet run"),
    p(82, 81, "/w/oslo/cda/bin/Debug/net9.0/Cda"),
  ]);
  const ports = new Map([
    [61, new Set([5173])],
    [72, new Set([3000])],
    [82, new Set([15081, 15082])],
  ]);
  const ls = listeners(procs, ports, new Map([[60, "term-1"]]), 50);
  assert.deepEqual(
    ls.map((l) => [l.pid, l.name, l.ports, l.terminalId, l.wrappers]),
    [
      [72, "node", [3000], undefined, [71]],
      [61, "node", [5173], "term-1", []],
      [82, "Cda", [15081, 15082], undefined, [81]],
    ],
  );
  assert.equal(runsFrom("node /w/oslo/api/server.js", ["/w/oslo/web", "/w/oslo/api"]), "/w/oslo/api");
  assert.equal(runsFrom("node /w/oslo/api2/server.js", ["/w/oslo/api"]), undefined);
});

test("terminals stop with Ctrl-C first, and hang up what ignores it", async () => {
  const where = { cwd: dir, env: {} };
  const nice = await terms.run("f", "a", "trap 'echo bye; exit 0' INT; echo up; while true; do sleep 0.1; done", where, "nice");
  await until(() => terms.output(nice.id).includes("up"));
  await terms.stop(nice.id, 5000);
  assert.match(terms.output(nice.id), /bye/);
  assert.equal(terms.list("f").find((t) => t.id === nice.id)?.exitCode, 0);

  const stubborn = await terms.run("f", "a", "trap '' INT; echo up; while true; do sleep 0.1; done", where, "stubborn");
  await until(() => terms.output(stubborn.id).includes("up"));
  const t0 = Date.now();
  await terms.stop(stubborn.id, 400);
  assert.ok(Date.now() - t0 >= 400);
  assert.notEqual(terms.list("f").find((t) => t.id === stubborn.id)?.exitCode, undefined, "hung up after the grace period");
});

test("the Run tab starts, shows and stops a feature's programs, and finds the ones it did not start", async () => {
  const web = join(dir, "oslo", "web");
  mkdirSync(web, { recursive: true });
  const server = join(web, "server.js");
  writeFileSync(
    server,
    "const s = require('http').createServer((q, r) => r.end('hi')).listen(0, '127.0.0.1', () => console.log('port=' + s.address().port));\n",
  );
  writeFileSync(join(web, "run_web.sh"), `#!/bin/bash\n# url: http://localhost:47811/ app\nexec node server.js\n`);
  writeFileSync(join(web, "run_fail.sh"), "echo nope; exit 2\n");
  const f: Feature = {
    id: "f-oslo",
    name: "oslo",
    folder: join(dir, "oslo"),
    port: 41000,
    createdAt: new Date().toISOString(),
    archived: false,
    repos: [{ name: "web", source: join(dir, "main-web"), path: web, branch: "caboose/oslo", baseRef: "main", setup: "none", copied: [] }],
  } as Feature;
  const runner = new Runner({
    terminals: terms,
    features: () => [f],
    repos: () => [],
    scriptsFor: () => ({}),
    scriptEnv: () => ({ CABOOSE_PORT: "41000" }),
    monikersFile: () => undefined,
  });

  let ov = await runner.overview(f.id);
  assert.deepEqual(
    ov.repos[0].scripts.map((s) => [s.id, s.label, s.state]),
    [
      ["run_fail.sh", "fail", "stopped"],
      ["run_web.sh", "web", "stopped"],
    ],
  );
  assert.equal(await runner.startAll(f.id), 2);
  const state = async (id: string) => (await runner.overview(f.id)).repos[0].scripts.find((s) => s.id === id)!;
  await until(async () => (await state("run_fail.sh")).state === "exited");
  assert.equal((await state("run_fail.sh")).exitCode, 2);
  const webRun = await state("run_web.sh");
  assert.equal(webRun.state, "running");
  assert.equal(await runner.startAll(f.id), 1, "only the exited one starts again");
  assert.equal(runner.browseUrl(f.id, "web", "run_web.sh", "http://localhost:47811/"), "http://localhost:47811/");
  assert.throws(() => runner.browseUrl(f.id, "web", "run_web.sh", "https://evil.example/"));

  // A server in one of our terminals is not a stray.
  await until(() => terms.output(webRun.terminalId!).includes("port="));
  ov = await runner.overview(f.id);
  if (ov.strayError) return void console.log("no lsof/ss:", ov.strayError);
  assert.deepEqual(ov.repos[0].strays, []);

  // One started by hand (or by an agent) from the worktree is, and can be stopped.
  const stray = spawn(process.execPath, [server], { cwd: web, stdio: "ignore", detached: true });
  stray.unref();
  await until(async () => (await runner.overview(f.id)).repos[0].strays.length > 0);
  ov = await runner.overview(f.id);
  const h = ov.repos[0].strays[0];
  assert.equal(h.pid, stray.pid);
  assert.equal(h.where, "oslo/web");
  assert.ok(h.stoppable);
  await runner.stopHolder(f.id, h.pid, 3000);
  await until(async () => (await runner.overview(f.id)).repos[0].strays.length === 0);

  await runner.stopAll(f.id, 3000);
  ov = await runner.overview(f.id);
  assert.deepEqual(
    ov.repos[0].scripts.map((s) => s.state),
    ["stopped", "stopped"],
  );
  assert.equal(terms.list(f.id).length, 0, "stopping closes their terminals");
});

test("the same program running in another feature is flagged, and each feature's programs are summed up", async () => {
  const mk = (name: string) => {
    const path = join(dir, name, "web");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "run_web.sh"), "exec sleep 30\n");
    writeFileSync(join(path, "run_api.sh"), "exec sleep 30\n");
    return { id: `f-${name}`, name, folder: join(dir, name), port: 41000, createdAt: "", archived: false, repos: [{ name: "web", source: join(dir, "src"), path, branch: `caboose/${name}`, baseRef: "main", setup: "none", copied: [] }] } as Feature;
  };
  const a = mk("bodo");
  const b = mk("finse");
  const runner = new Runner({ terminals: terms, features: () => [a, b], repos: () => [], scriptsFor: () => ({}), scriptEnv: () => ({}), monikersFile: () => undefined, system: async () => ({ procs: new Map(), ports: new Map() }) });
  await runner.start(a.id, "web", "run_web.sh");
  const ov = await runner.overview(b.id);
  const web = ov.repos[0].scripts.find((s) => s.id === "run_web.sh")!;
  assert.deepEqual(web.elsewhere, [{ featureId: a.id, feature: "bodo" }]);
  assert.equal(ov.repos[0].scripts.find((s) => s.id === "run_api.sh")!.elsewhere, undefined, "a different program is fine");
  const sum = runner.summary();
  assert.deepEqual([sum[a.id].running, sum[a.id].total], [1, 2]);
  assert.equal(sum[b.id].running, 0);
  await runner.stopAll(a.id, 1000);
});
