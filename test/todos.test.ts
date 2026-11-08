// The user's to-do list: todo.md, written by agents (AddTodo) and ticked in Caboose.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Comments } from "../src/main/core/comments.ts";
import { addTodo, readDocs, setTodo } from "../src/main/core/docs.ts";
import { cabooseHandlers } from "../src/main/core/mcp.ts";
import { Store } from "../src/main/core/store.ts";
import { formatTodo, parseTodos } from "../src/shared/todos.ts";
import type { Feature } from "../src/shared/types.ts";

const dir = mkdtempSync(join(tmpdir(), "caboose-todo-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("todo.md: items with a repo, who asked, and indented markdown details (code blocks too)", () => {
  const md = [
    "# To do",
    "",
    "- [ ] [orders] Run the orders migration on test <!-- from: orders -->",
    "  The new column must exist before the deploy.",
    "",
    "  ```sh",
    "  npm run migrate -- --env test",
    "  ```",
    "- [x] Set the PAYMENT_KEY secret <!-- from: feature -->",
    "- [ ] Ask ops for access",
    "Not an item.",
  ].join("\n");
  assert.deepEqual(parseTodos(md), [
    { line: 2, done: false, title: "Run the orders migration on test", repo: "orders", from: "orders", details: "The new column must exist before the deploy.\n\n```sh\nnpm run migrate -- --env test\n```" },
    { line: 8, done: true, title: "Set the PAYMENT_KEY secret", from: "feature" },
    { line: 9, done: false, title: "Ask ops for access" },
  ]);
  const one = { title: "Grant  the\nrole", details: "Run:\n```\naz role assign\n```", repo: "api", from: "api" };
  assert.deepEqual(parseTodos(formatTodo(one))[0], { line: 0, done: false, title: "Grant the role", repo: "api", from: "api", details: one.details }, "written and read back the same");
});

test("adding and ticking keeps the file readable, and the docs count what is open", () => {
  const a = addTodo(dir, { title: "Run the migration on test", details: "```sh\nnpm run migrate\n```", repo: "orders", from: "orders" });
  addTodo(dir, { title: "Set the secret", from: "feature" });
  assert.match(readFileSync(join(dir, "todo.md"), "utf8"), /^# To do\n\nSteps for you to do by hand\. Tick them in Caboose when done\.\n\n- \[ \] \[orders\] Run the migration/);
  assert.equal(readDocs(dir, []).todos.length, 2);
  const t = setTodo(dir, a.line, true);
  assert.equal(t.done, true);
  assert.deepEqual(readDocs(dir, []).todos.map((x) => x.done), [true, false]);
  assert.throws(() => setTodo(dir, 0, true), /not a to-do/);
  assert.throws(() => addTodo(dir, { title: "  " }), /needs a title/);
});

test("AddTodo: from the repo chat it is about that repo; unknown repos are refused", () => {
  const folder = mkdtempSync(join(dir, "f-"));
  const feature = { id: "f", name: "oslo", folder, createdAt: "", archived: false, port: 41000, repos: [{ name: "orders", source: folder, path: folder, branch: "b", baseRef: "main", setup: "none" }] } as Feature;
  const chat = { id: "c", featureId: "f", repo: "orders", title: "orders", model: "default", effort: "high", mode: "default", createdAt: "" } as never;
  const h = cabooseHandlers(() => feature, new Comments(new Store(join(folder, "s.json"))), undefined, { chat: () => chat });
  assert.match(h.addTodo({ title: "Run the migration on test", details: "```sh\nnpm run migrate\n```" }), /Added to the user's to-do list \(1 open\): Run the migration on test/);
  assert.deepEqual(readDocs(folder, []).todos[0], { line: 4, done: false, title: "Run the migration on test", repo: "orders", from: "orders", details: "```sh\nnpm run migrate\n```" });
  assert.match(h.addTodo({ title: "x", repo: "nope" }), /No repo "nope"/);
});
