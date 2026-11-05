// Real ptys: a shell, the run script, plain-text output and stopping.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { cabooseHandlers } from "../src/main/core/mcp.ts";
import { Comments } from "../src/main/core/comments.ts";
import { Store } from "../src/main/core/store.ts";
import { plain, Terminals } from "../src/main/core/terminals.ts";
import type { Workspace } from "../src/shared/types.ts";

const dir = mkdtempSync(join(tmpdir(), "caboose-term-"));
const data = new Map<string, string>();
let changes = 0;
const terms = new Terminals({
  onData: (id, d) => data.set(id, (data.get(id) ?? "") + d),
  onChange: () => changes++,
});
after(() => {
  terms.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (fn: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};
const where = { cwd: dir, env: { CABOOSE_PORT: "41010" } };

test("the run script runs through bash in the workspace with its port", async () => {
  const t = await terms.run("w1", "echo port=$CABOOSE_PORT in $(basename $PWD); exit 3", where);
  await until(() => terms.list("w1").find((x) => x.id === t.id)?.exitCode !== undefined);
  assert.equal(terms.list("w1")[0].exitCode, 3);
  assert.match(terms.output(t.id), new RegExp(`port=41010 in ${dir.split("/").pop()}`));
  assert.match(terms.output(t.id), /process exited with code 3/);
  assert.ok(data.get(t.id)?.includes("port=41010"), "output is streamed");
});

test("running again replaces the previous run", async () => {
  await terms.run("w1", "sleep 30", where);
  await terms.run("w1", "echo second", where);
  const runs = terms.list("w1").filter((t) => t.kind === "run");
  assert.equal(runs.length, 1);
  await until(() => terms.output(runs[0].id).includes("second"));
});

test("a shell takes input, and stop ends a long-running process", async () => {
  const t = terms.openShell("w2", where);
  terms.write(t.id, "echo hello-$((40+2))\r");
  await until(() => terms.output(t.id).includes("hello-42"));
  const run = await terms.run("w2", "while true; do echo tick; sleep 0.1; done", where);
  await until(() => terms.output(run.id).includes("tick"));
  terms.stop(run.id);
  await until(() => terms.list("w2").find((x) => x.id === run.id)?.exitCode !== undefined);
  terms.closeWorkspace("w2");
  assert.equal(terms.list("w2").length, 0);
  assert.ok(changes > 0);
});

test("plain() strips colours and keeps the last state of overwritten lines", () => {
  assert.equal(plain("\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\r\n\x1b]0;title\x07done"), "ok\n100%\ndone");
});

test("Claude reads the run terminal by default, or one by title", async () => {
  const ws = { id: "w3", path: dir, baseRef: "main" } as Workspace;
  const h = cabooseHandlers(() => ws, new Comments(new Store(join(dir, "s.json"))), terms);
  assert.match(h.getTerminalOutput({}), /No terminals/);
  const shell = terms.openShell("w3", where);
  terms.write(shell.id, "echo from-shell\r");
  const run = await terms.run("w3", "echo server listening; sleep 5", where);
  await until(() => terms.output(run.id).includes("listening") && terms.output(shell.id).includes("from-shell"));
  assert.match(h.getTerminalOutput({}), /Terminal "Run" \(running[\s\S]*server listening/);
  assert.match(h.getTerminalOutput({ terminal: "Terminal" }), /from-shell/);
  terms.closeWorkspace("w3");
});
