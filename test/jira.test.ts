import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Jira, parseKey, readFeatureJira, writeFeatureJira } from "../src/main/core/jira.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-jira-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A fake Jira: records calls and answers from a table. */
function fakeFetch(routes: Record<string, (body: any) => [number, unknown]>) {
  const calls: { method: string; path: string; auth: string; body?: any }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname + u.search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path, auth: String((init.headers as Record<string, string>).Authorization), body });
    const route = Object.keys(routes).find((r) => `${init.method} ${path}`.startsWith(r));
    const [status, json] = route ? routes[route](body) : [404, { errorMessages: ["no route"] }];
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { fn, calls };
}

const auth = { site: "https://acme.atlassian.net/", email: "me@acme.com", token: "t0k" };

test("keys are found in keys and URLs", () => {
  assert.equal(parseKey("abc-123"), "ABC-123");
  assert.equal(parseKey("https://acme.atlassian.net/browse/ABC-77?focus=1"), "ABC-77");
  assert.equal(parseKey("no key here"), null);
});

test("issues are read with basic auth and get browse URLs", async () => {
  const f = fakeFetch({
    "GET /rest/api/3/issue/ABC-1": () => [200, { key: "ABC-1", fields: { summary: "Big thing", status: { name: "In Progress" }, issuetype: { name: "Story" }, subtasks: [{ key: "ABC-2", fields: { summary: "web" } }] } }],
  });
  const j = new Jira(auth, f.fn);
  const i = await j.issue("ABC-1");
  assert.deepEqual(i, { key: "ABC-1", summary: "Big thing", status: "In Progress", type: "Story", url: "https://acme.atlassian.net/browse/ABC-1", subtasks: [{ key: "ABC-2", summary: "web" }] });
  assert.equal(f.calls[0].auth, `Basic ${Buffer.from("me@acme.com:t0k").toString("base64")}`);
});

test("subtasks are created with the project's sub-task type under the parent", async () => {
  const f = fakeFetch({
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes": () => [200, { issueTypes: [{ id: "1", name: "Story" }, { id: "5", name: "Underoppgave", subtask: true }] }],
    "POST /rest/api/3/issue": () => [201, { key: "ABC-9" }],
  });
  const key = await new Jira(auth, f.fn).createSubtask("ABC-1", "web: Big thing");
  assert.equal(key, "ABC-9");
  assert.deepEqual(f.calls.find((c) => c.method === "POST")!.body.fields, { project: { key: "ABC" }, parent: { key: "ABC-1" }, summary: "web: Big thing", issuetype: { id: "5" } });
});

test("new tasks prefer the Task type", async () => {
  const f = fakeFetch({
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes": () => [200, { values: [{ id: "1", name: "Story" }, { id: "3", name: "Task" }, { id: "5", name: "Sub-task", subtask: true }] }],
    "POST /rest/api/3/issue": () => [201, { key: "ABC-10" }],
  });
  assert.equal(await new Jira(auth, f.fn).createTask("ABC", "Do it"), "ABC-10");
  assert.equal(f.calls.find((c) => c.method === "POST")!.body.fields.issuetype.id, "3");
});

test("errors say what went wrong", async () => {
  const f = fakeFetch({ "GET /rest/api/3/myself": () => [401, {}] });
  await assert.rejects(new Jira(auth, f.fn).myself(), /email or API token is wrong/);
  assert.throws(() => new Jira({ ...auth, site: "http://acme.atlassian.net" }), /https/);
  assert.doesNotThrow(() => new Jira({ ...auth, site: "http://localhost:1234" }));
});

test("jira.txt round-trips and tolerates hand edits", () => {
  writeFeatureJira(tmp, { task: "ABC-1", subtasks: { "family-app": "ABC-2", sheets: "ABC-3" } });
  assert.equal(readFileSync(join(tmp, "jira.txt"), "utf8"), "ABC-1\nfamily-app: ABC-2\nsheets: ABC-3\n");
  assert.deepEqual(readFeatureJira(tmp), { task: "ABC-1", subtasks: { "family-app": "ABC-2", sheets: "ABC-3" } });
  writeFileSync(join(tmp, "jira.txt"), "# feature\nhttps://acme.atlassian.net/browse/ABC-5\n\nweb : https://acme.atlassian.net/browse/ABC-6\n");
  assert.deepEqual(readFeatureJira(tmp), { task: "ABC-5", subtasks: { web: "ABC-6" } });
  writeFeatureJira(tmp, { subtasks: {} });
  assert.deepEqual(readFeatureJira(tmp), { subtasks: {} });
});

test("a typed key or issue link is a key; a summary that mentions one is not", async () => {
  const { parseKeyLike } = await import("../src/shared/jirakey.ts");
  assert.equal(parseKeyLike(" abc-123 "), "ABC-123");
  assert.equal(parseKeyLike("https://acme.atlassian.net/browse/ABC-77?focus=1"), "ABC-77");
  assert.equal(parseKeyLike("Fix ABC-12 again"), null);
  assert.equal(parseKeyLike("Gift receipts"), null);
});

test("fields the project requires on new issues: the parent's value, else the user for a person field, else a clear error", async () => {
  const meta = {
    fields: [
      { fieldId: "summary", name: "Summary", required: true },
      { fieldId: "reporter", name: "Reporter", required: true, hasDefaultValue: true },
      { fieldId: "customfield_11882", name: "Owner", required: true, schema: { type: "user" } },
      { fieldId: "customfield_200", name: "Team", required: true, schema: { type: "option" } },
    ],
  };
  const f = fakeFetch({
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes/5": () => [200, meta],
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes": () => [200, { issueTypes: [{ id: "3", name: "Task" }, { id: "5", name: "Sub-task", subtask: true }] }],
    "GET /rest/api/3/issue/ABC-1?fields=customfield_11882,customfield_200": () => [200, { fields: { customfield_11882: { accountId: "owner-1", displayName: "Ola" }, customfield_200: { id: "77", value: "Commerce" } } }],
    "POST /rest/api/3/issue": () => [201, { key: "ABC-9" }],
  });
  assert.equal(await new Jira(auth, f.fn).createSubtask("ABC-1", "web: Big thing"), "ABC-9");
  assert.deepEqual(f.calls.find((c) => c.method === "POST")!.body.fields, {
    project: { key: "ABC" },
    parent: { key: "ABC-1" },
    summary: "web: Big thing",
    issuetype: { id: "5" },
    customfield_11882: { accountId: "owner-1" },
    customfield_200: { id: "77" },
  }, "copied from the parent task");

  // A new task has no parent: a person field gets the user; anything else cannot be guessed.
  const g = fakeFetch({
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes/3": () => [200, { fields: [meta.fields[2]] }],
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes": () => [200, { issueTypes: [{ id: "3", name: "Task" }] }],
    "GET /rest/api/3/myself": () => [200, { accountId: "me-42" }],
    "POST /rest/api/3/issue": () => [201, { key: "ABC-10" }],
  });
  assert.equal(await new Jira(auth, g.fn).createTask("ABC", "Do it"), "ABC-10");
  assert.deepEqual(g.calls.find((c) => c.method === "POST")!.body.fields.customfield_11882, { accountId: "me-42" });
  const h = fakeFetch({
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes/3": () => [200, { fields: [meta.fields[3]] }],
    "GET /rest/api/3/issue/createmeta/ABC/issuetypes": () => [200, { issueTypes: [{ id: "3", name: "Task" }] }],
  });
  await assert.rejects(new Jira(auth, h.fn).createTask("ABC", "Do it"), /Jira project ABC requires Team on a new Task, which Caboose cannot fill in/);
});

test("a description that starts with a key names the task", async () => {
  const { leadingKey } = await import("../src/shared/jirakey.ts");
  assert.equal(leadingKey("NWP-8259 Feature toggle i VAM for Commerce API"), "NWP-8259");
  assert.equal(leadingKey("  nwp-8259: toggle"), "NWP-8259");
  assert.equal(leadingKey("Feature toggle for NWP-8259"), null, "only at the start");
  assert.equal(leadingKey("UTF-8 everywhere"), "UTF-8", "looks like one: creating the feature checks it with Jira");
});

test("an issue goes back in progress through a transition to an in-progress status, preferring \"In Progress\"", async () => {
  const f = fakeFetch({
    "GET /rest/api/3/issue/ABC-1?fields=status": () => [200, { fields: { status: { name: "Done", statusCategory: { key: "done" } } } }],
    "GET /rest/api/3/issue/ABC-1/transitions": () => [
      200,
      {
        transitions: [
          { id: "11", name: "Review", to: { name: "In Review", statusCategory: { key: "indeterminate" } } },
          { id: "21", name: "Reopen", to: { name: "In Progress", statusCategory: { key: "indeterminate" } } },
          { id: "31", name: "Close", to: { name: "Closed", statusCategory: { key: "done" } } },
        ],
      },
    ],
    "POST /rest/api/3/issue/ABC-1/transitions": () => [200, {}],
    "GET /rest/api/3/issue/ABC-2?fields=status": () => [200, { fields: { status: { name: "In Progress", statusCategory: { key: "indeterminate" } } } }],
  });
  const j = new Jira(auth, f.fn);
  assert.equal(await j.startProgress("ABC-1"), "In Progress");
  assert.deepEqual(f.calls.at(-1)!.body, { transition: { id: "21" } });
  assert.equal(await j.startProgress("ABC-2"), null, "already in progress: nothing to do");
});
