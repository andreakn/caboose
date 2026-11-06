import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { appendLog, readDocs, readLog, reportedStatuses, setTask, writeDoc, writeRepoBrief } from "../src/main/core/docs.ts";

const dir = mkdtempSync(join(tmpdir(), "caboose-docs-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("plan tasks are read, ticked and counted", () => {
  writeDoc(dir, "plan", "# Plan\n\n- [ ] API contract\n  - [x] field names\n* [X] Storefront\nnot a task\n");
  const d = readDocs(dir, []);
  assert.deepEqual(d.tasks.map((t) => [t.line, t.done, t.text, t.depth]), [
    [2, false, "API contract", 0],
    [3, true, "field names", 1],
    [4, true, "Storefront", 0],
  ]);
  assert.deepEqual(d.progress, { done: 2, total: 3 });
  setTask(dir, 2, true);
  setTask(dir, 4, false);
  assert.match(readFileSync(join(dir, "plan.md"), "utf8"), /- \[x\] API contract\n {2}- \[x\] field names\n\* \[ \] Storefront/);
  assert.throws(() => setTask(dir, 5, true), /not a task/);
});

test("the log is append-only markdown with statuses; the latest status per repo wins", () => {
  const t = (s: string) => new Date(`2026-11-06T${s}`);
  appendLog(dir, { from: "coordinator", text: "Feature created." }, t("10:00:00"));
  appendLog(dir, { from: "web", status: "working", text: "Starting on the cart." }, t("10:01:00"));
  appendLog(dir, { from: "you", to: "web", text: "Keep the old\nendpoint for now." }, t("10:02:00"));
  appendLog(dir, { from: "web", status: "needs-input", text: "Which currency?" }, t("10:03:00"));
  const log = readLog(dir);
  assert.equal(log.length, 4);
  assert.deepEqual(log[2], { at: "2026-11-06 10:02:00", from: "you", to: "web", text: "Keep the old\nendpoint for now." });
  assert.deepEqual(reportedStatuses(log), { web: { status: "needs-input", at: "2026-11-06 10:03:00", text: "Which currency?" } });
  assert.throws(() => appendLog(dir, { from: "web", status: "nope" as never, text: "x" }), /Unknown status/);
  // separators cannot be smuggled into the header
  appendLog(dir, { from: "a · b → c", text: "x" });
  assert.equal(readLog(dir).at(-1)!.from, "a b c");
});

test("brief and per-repo briefs", () => {
  writeDoc(dir, "brief", "# Checkout v2");
  writeRepoBrief(dir, "web", "Do the web part.");
  writeFileSync(join(dir, "briefs", "api.md"), "API part\n");
  const d = readDocs(dir, ["web", "api", "missing"]);
  assert.equal(d.brief, "# Checkout v2\n");
  assert.deepEqual(d.repoBriefs, { web: "Do the web part.\n", api: "API part\n", missing: "" });
});
