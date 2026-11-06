// The central chat breaking out repo chats, notes from the user, status reports, with a fake agent.
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ClaudeProvider, type QueryLike } from "../src/main/core/agents/claude.ts";
import { Chats } from "../src/main/core/chats.ts";
import { Comments } from "../src/main/core/comments.ts";
import { Coordinator } from "../src/main/core/coordination.ts";
import { readLog } from "../src/main/core/docs.ts";
import { cabooseHandlers, cabooseInstructions } from "../src/main/core/mcp.ts";
import { Store } from "../src/main/core/store.ts";
import type { Feature } from "../src/shared/types.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-coord-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** An agent that answers every message with "ok: <first line>", slowly when told "slow". */
function fakeAgent() {
  const sessions: { options: Options; prompts: string[] }[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const fn = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): QueryLike => {
    const s = { options, prompts: [] as string[] };
    sessions.push(s);
    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: `s${sessions.length}` } as SDKMessage;
      let n = 0;
      for await (const m of prompt) {
        const text = String(m.message.content);
        s.prompts.push(text);
        n++;
        if (text.includes("slow")) await gate;
        yield { type: "assistant", uuid: `${sessions.length}-${n}`, parent_tool_use_id: null, message: { content: [{ type: "text", text: `ok: ${text.split("\n")[0]}` }] } } as SDKMessage;
        yield { type: "result", subtype: "success", is_error: false, uuid: `r${sessions.length}-${n}`, duration_ms: 1, num_turns: 1, result: "" } as SDKMessage;
      }
    }
    const gen = run();
    return Object.assign(gen, { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, applyFlagSettings: async () => {}, close: () => void gen.return(undefined) });
  };
  return { fn, sessions, release: () => release() };
}

const folder = join(tmp, "finse");
for (const r of ["web", "api"]) mkdirSync(join(folder, r), { recursive: true });
const feature: Feature = {
  id: "f1", name: "finse", title: "Checkout v2", folder, createdAt: "", archived: false, port: 41000,
  repos: [
    { name: "web", source: "/src/web", path: join(folder, "web"), branch: "caboose/NWP-2-finse", baseRef: "origin/main", setup: "none" },
    { name: "api", source: "/src/api", path: join(folder, "api"), branch: "caboose/NWP-3-finse", baseRef: "origin/main", setup: "none" },
  ],
};

function setup() {
  const store = new Store(join(tmp, `${Math.random()}`, "state.json"));
  store.update((s) => ({ ...s, features: [feature] }));
  const agent = fakeAgent();
  const chats = new Chats(store, join(tmp, `${Math.random()}`), { claude: new ClaudeProvider(agent.fn) }, () => {});
  const coord = new Coordinator({
    store, chats, jiraOf: () => ({ task: "NWP-1", subtasks: { web: "NWP-2", api: "NWP-3" } }),
    facts: async (r) => ({ uncommitted: r.name === "web" ? 2 : 0, ahead: 1, pushed: false, pr: null }),
  });
  return { store, chats, coord, agent };
}
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fn(), "timed out");
};

test("a repo chat works in its worktree, reads the feature folder, and starts with a standalone kickoff", async () => {
  const { chats, coord, agent } = setup();
  const r = coord.startRepoChat("f1", "web", "Add the gift-receipt toggle to the cart.");
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.equal(r.value.repo, "web");
  assert.equal(r.value.title, "web");
  await until(() => agent.sessions[0]?.prompts.length === 1);
  const s = agent.sessions[0];
  assert.equal(s.options.cwd, join(folder, "web"));
  assert.deepEqual(s.options.additionalDirectories, [folder]);
  const kickoff = s.prompts[0];
  assert.match(kickoff, /agent for the web repo in the feature "Checkout v2"/);
  assert.match(kickoff, new RegExp(`${folder}/briefs/web.md`));
  assert.match(kickoff, /mcp__caboose__ReportStatus/);
  assert.match(kickoff, /Add the gift-receipt toggle/);
  assert.match(readLog(folder).at(-1)!.text, /Started a chat for web/);

  // A second start for the same repo goes to the existing chat.
  const again = coord.startRepoChat("f1", "web", "Also the receipt PDF.");
  assert.ok(again.ok && again.value.id === r.value.id);
  await until(() => s.prompts.length === 2);
  assert.match(s.prompts[1], /^Message from the coordinator:\nAlso the receipt PDF\./);
  await until(() => !chats.state(r.value.id).running);
  assert.match(coord.repoChat("f1", "web"), /is idle[\s\S]*ok: Message from the coordinator:/);
});

test("messages to a busy repo chat are queued; a repo with no chat says so", async () => {
  const { chats, coord, agent } = setup();
  const r = coord.startRepoChat("f1", "api", "slow task");
  assert.ok(r.ok);
  await until(() => chats.state(r.value.id).running);
  const sent = coord.messageRepoChat("f1", "api", "One more thing");
  assert.ok(sent.ok && /Queued/.test(sent.value));
  agent.release();
  await until(() => agent.sessions[0].prompts.length === 2);
  const none = coord.messageRepoChat("f1", "web", "hi");
  assert.equal(none.ok, false);
});

test("notes from the user are logged and reach the chats they are for", async () => {
  const { chats, coord, agent } = setup();
  const central = chats.create("f1");
  assert.ok(central.ok);
  const web = coord.startRepoChat("f1", "web", "task");
  assert.ok(web.ok);
  await until(() => agent.sessions.length === 1 && !chats.state(web.value.id).running);

  const toApi = coord.noteFromUser("f1", "api", "Keep the v1 endpoint.");
  assert.ok(toApi.ok);
  assert.deepEqual(toApi.value, [central.value.id], "api has no chat: the central chat gets it");
  const toAll = coord.noteFromUser("f1", "all", "Demo on Friday.");
  assert.ok(toAll.ok);
  assert.deepEqual(new Set(toAll.value), new Set([central.value.id, web.value.id]));
  await until(() => agent.sessions.length === 2 && agent.sessions[1].prompts.length === 2);
  assert.deepEqual(agent.sessions[1].prompts, ["Note from the user (about api):\nKeep the v1 endpoint.", "Note from the user:\nDemo on Friday."]);
  const log = readLog(folder).slice(-2);
  assert.deepEqual(log.map((e) => [e.from, e.to]), [["you", "api"], ["you", undefined]]);
});

test("status reports come from repo chats (or name the repo), and the overview shows them", async () => {
  const { store, chats, coord } = setup();
  const web = chats.create("f1", "claude", "web");
  const central = chats.create("f1");
  assert.ok(web.ok && central.ok);
  const ctx = (id: string) => ({ coord, chat: () => store.get().chats.find((c) => c.id === id) });
  const comments = new Comments(store);
  const inWeb = cabooseHandlers(() => feature, comments, undefined, ctx(web.value.id));
  const inCentral = cabooseHandlers(() => feature, comments, undefined, ctx(central.value.id));

  assert.equal(inWeb.reportStatus({ status: "needs-input", note: "Which currency?" }), "Logged: web is needs-input.");
  assert.match(inCentral.reportStatus({ status: "working", note: "x" }), /Say which repo/);
  assert.equal(inCentral.reportStatus({ status: "working", note: "Starting.", repo: "api" }), "Logged: api is working.");
  assert.equal(inCentral.log({ text: "Contract: amount in øre." }), "Logged.");
  assert.equal(readLog(folder).at(-1)!.from, "coordinator");

  const status = await inCentral.featureStatus();
  assert.match(status, /Feature finse — Checkout v2 \[active\] · Jira NWP-1/);
  assert.match(status, /- web \(caboose\/NWP-2-finse\): reported needs-input \([^)]*: Which currency\?\) · chat idle · 2 uncommitted, 1 commit\(s\) ahead, not pushed · no PR · Jira NWP-2/);
  assert.match(status, /- api \(caboose\/NWP-3-finse\): reported working/);
  assert.match(status, /Recent log:[\s\S]*coordinator: Contract: amount in øre\./);
});

test("the central chat and repo chats get their own system notes", () => {
  const central = cabooseInstructions(feature, "copilot");
  assert.match(central, /central chat of the feature "Checkout v2"/);
  assert.match(central, /caboose_start_repo_chat/);
  const repo = cabooseInstructions(feature, "claude", { id: "c", featureId: "f1", repo: "api", title: "api", model: "default", effort: "high", mode: "acceptEdits", createdAt: "" });
  assert.match(repo, /agent for the api repo/);
  assert.match(repo, /You work in .*\/api, a git worktree on branch caboose\/NWP-3-finse/);
  assert.doesNotMatch(repo, /central chat/);
});
