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
  assert.equal(parseKey("nwp-123"), "NWP-123");
  assert.equal(parseKey("https://acme.atlassian.net/browse/NWP-77?focus=1"), "NWP-77");
  assert.equal(parseKey("no key here"), null);
});

test("issues are read with basic auth and get browse URLs", async () => {
  const f = fakeFetch({
    "GET /rest/api/3/issue/NWP-1": () => [200, { key: "NWP-1", fields: { summary: "Big thing", status: { name: "In Progress" }, issuetype: { name: "Story" }, subtasks: [{ key: "NWP-2", fields: { summary: "web" } }] } }],
  });
  const j = new Jira(auth, f.fn);
  const i = await j.issue("NWP-1");
  assert.deepEqual(i, { key: "NWP-1", summary: "Big thing", status: "In Progress", type: "Story", url: "https://acme.atlassian.net/browse/NWP-1", subtasks: [{ key: "NWP-2", summary: "web" }] });
  assert.equal(f.calls[0].auth, `Basic ${Buffer.from("me@acme.com:t0k").toString("base64")}`);
});

test("subtasks are created with the project's sub-task type under the parent", async () => {
  const f = fakeFetch({
    "GET /rest/api/3/issue/createmeta/NWP/issuetypes": () => [200, { issueTypes: [{ id: "1", name: "Story" }, { id: "5", name: "Underoppgave", subtask: true }] }],
    "POST /rest/api/3/issue": () => [201, { key: "NWP-9" }],
  });
  const key = await new Jira(auth, f.fn).createSubtask("NWP-1", "web: Big thing");
  assert.equal(key, "NWP-9");
  assert.deepEqual(f.calls[1].body.fields, { project: { key: "NWP" }, parent: { key: "NWP-1" }, summary: "web: Big thing", issuetype: { id: "5" } });
});

test("new tasks prefer the Task type", async () => {
  const f = fakeFetch({
    "GET /rest/api/3/issue/createmeta/NWP/issuetypes": () => [200, { values: [{ id: "1", name: "Story" }, { id: "3", name: "Task" }, { id: "5", name: "Sub-task", subtask: true }] }],
    "POST /rest/api/3/issue": () => [201, { key: "NWP-10" }],
  });
  assert.equal(await new Jira(auth, f.fn).createTask("NWP", "Do it"), "NWP-10");
  assert.equal(f.calls[1].body.fields.issuetype.id, "3");
});

test("errors say what went wrong", async () => {
  const f = fakeFetch({ "GET /rest/api/3/myself": () => [401, {}] });
  await assert.rejects(new Jira(auth, f.fn).myself(), /email or API token is wrong/);
  assert.throws(() => new Jira({ ...auth, site: "http://acme.atlassian.net" }), /https/);
  assert.doesNotThrow(() => new Jira({ ...auth, site: "http://localhost:1234" }));
});

test("jira.txt round-trips and tolerates hand edits", () => {
  writeFeatureJira(tmp, { task: "NWP-1", subtasks: { "family-app": "NWP-2", sheets: "NWP-3" } });
  assert.equal(readFileSync(join(tmp, "jira.txt"), "utf8"), "NWP-1\nfamily-app: NWP-2\nsheets: NWP-3\n");
  assert.deepEqual(readFeatureJira(tmp), { task: "NWP-1", subtasks: { "family-app": "NWP-2", sheets: "NWP-3" } });
  writeFileSync(join(tmp, "jira.txt"), "# feature\nhttps://acme.atlassian.net/browse/NWP-5\n\nweb : https://acme.atlassian.net/browse/NWP-6\n");
  assert.deepEqual(readFeatureJira(tmp), { task: "NWP-5", subtasks: { web: "NWP-6" } });
  writeFeatureJira(tmp, { subtasks: {} });
  assert.deepEqual(readFeatureJira(tmp), { subtasks: {} });
});
