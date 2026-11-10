// Chats against a fake SDK query(), so no Claude usage and no network.
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyEvent, type ChatEvent, type ChatItem, emptyView } from "../src/shared/chat.ts";
import { ClaudeProvider, type QueryLike } from "../src/main/core/agents/claude.ts";
import { Chats } from "../src/main/core/chats.ts";
import { Store } from "../src/main/core/store.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-chats-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Replies to each message; "use tool" asks for permission to run Bash first; "slow" waits for release(). */
function fakeQuery() {
  const calls: { options: Options; interrupted: number; model?: string } = { options: {}, interrupted: 0 };
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const fn = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): QueryLike => {
    calls.options = options;
    async function* run(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "sess-1" } as SDKMessage;
      let n = 0;
      for await (const msg of prompt) {
        const text = String(msg.message.content);
        n++;
        if (text === "slow") await gate;
        yield {
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        } as SDKMessage;
        yield {
          type: "stream_event",
          parent_tool_use_id: null,
          event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
        } as SDKMessage;
        if (text === "ask") {
          const decision = await options.canUseTool!(
            "AskUserQuestion",
            { questions: [{ question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }] },
            { signal: new AbortController().signal, toolUseID: "q1" } as never,
          );
          const answer = decision?.behavior === "allow" ? JSON.stringify(decision.updatedInput?.answers) : decision?.message;
          yield {
            type: "assistant",
            uuid: `q${n}`,
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: `answer: ${answer}` }] },
          } as SDKMessage;
        }
        if (text === "use tool") {
          const decision = await options.canUseTool!("Bash", { command: "ls" }, {
            signal: new AbortController().signal,
            toolUseID: "tu1",
          } as never);
          yield {
            type: "assistant",
            uuid: `a${n}`,
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] },
          } as SDKMessage;
          yield {
            type: "user",
            parent_tool_use_id: null,
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "tu1", content: decision?.behavior ?? "deny", is_error: decision?.behavior !== "allow" }],
            },
          } as SDKMessage;
        }
        yield {
          type: "assistant",
          uuid: `b${n}`,
          parent_tool_use_id: null,
          message: { content: [{ type: "text", text: `Hello, you said ${text}` }] },
        } as SDKMessage;
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          uuid: `r${n}`,
          duration_ms: 10,
          num_turns: 1,
          result: "",
        } as SDKMessage;
      }
    }
    const gen = run();
    return Object.assign(gen, {
      interrupt: async () => void calls.interrupted++,
      setModel: async (m?: string) => void (calls.model = m),
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      close: () => void gen.return(undefined),
    });
  };
  return { fn, calls, release: () => release() };
}

function setup() {
  const store = new Store(join(tmp, `${Math.random()}`, "state.json"));
  store.update((s) => ({
    ...s,
    features: [{ id: "w1", name: "finse", folder: tmp, createdAt: "", archived: false, port: 41000, repos: [] }],
  }));
  const fake = fakeQuery();
  const events: ChatEvent[] = [];
  const chats = new Chats(store, join(tmp, `${Math.random()}`), { claude: new ClaudeProvider(fake.fn) }, (_id, e) => events.push(e));
  const chat = chats.create("w1");
  assert.ok(chat.ok);
  return { store, chats, fake, events, chatId: chat.value.id };
}

const view = (events: ChatEvent[]) => events.reduce(applyEvent, emptyView());
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fn(), "timed out");
};

test("a message streams a draft, then the full reply, and saves the session id", async () => {
  const { store, chats, fake, events, chatId } = setup();
  chats.send(chatId, "hi");
  await until(() => !view(events).running && events.some((e) => e.t === "result"));
  assert.ok(events.some((e) => e.t === "draft" && e.text === "Hel"));
  const v = view(events);
  assert.deepEqual(v.items.map((i) => i.kind), ["user", "text", "result"]);
  assert.equal(v.draft, undefined);
  const chat = store.get().chats[0];
  assert.equal(chat.sessionId, "sess-1");
  assert.equal(chat.title, "hi");
  assert.equal(fake.calls.options.cwd, tmp);
  assert.equal(fake.calls.options.permissionMode, "bypassPermissions", "new chats start in the configured mode");
});

test("the transcript is saved and replays to the same items", async () => {
  const { chats, events, chatId } = setup();
  chats.send(chatId, "hi");
  await until(() => events.some((e) => e.t === "result"));
  assert.deepEqual(view(chats.events(chatId)).items, view(events).items);
});

test("messages sent while a turn runs are queued and sent after it", async () => {
  const { chats, fake, events, chatId } = setup();
  chats.send(chatId, "slow");
  await until(() => view(events).running);
  chats.send(chatId, "second");
  await until(() => view(events).queued.length === 1);
  fake.release();
  await until(() => events.filter((e) => e.t === "result").length === 2);
  const texts = view(events).items.filter((i) => i.kind === "text").map((i) => (i as { text: string }).text);
  assert.deepEqual(texts, ["Hello, you said slow", "Hello, you said second"]);
  assert.deepEqual(view(events).queued, []);
});

test("a tool waits for the user's answer", async () => {
  const { chats, events, chatId } = setup();
  chats.send(chatId, "use tool");
  await until(() => view(events).items.some((i) => i.kind === "permission"));
  const p = view(events).items.find((i) => i.kind === "permission")!;
  chats.answerPermission(chatId, p.id, "deny");
  await until(() => events.some((e) => e.t === "result"));
  const v = view(events);
  assert.equal(v.items.find((i) => i.kind === "permission" && i.answer === false)?.id, p.id);
  const tool = v.items.find((i) => i.kind === "tool");
  assert.ok(tool?.kind === "tool" && tool.result?.isError);
});

test("stop interrupts, drops the queue and denies open questions", async () => {
  const { chats, fake, events, chatId } = setup();
  chats.send(chatId, "use tool");
  await until(() => view(events).items.some((i) => i.kind === "permission"));
  chats.send(chatId, "queued");
  await chats.interrupt(chatId);
  assert.equal(fake.calls.interrupted, 1);
  assert.deepEqual(view(events).queued, []);
  assert.ok(view(events).items.some((i) => i.kind === "permission" && i.answer === false));
});

test("settings follow into the live session and into the next chat", async () => {
  const { store, chats, fake, events, chatId } = setup();
  chats.send(chatId, "hi");
  await until(() => events.some((e) => e.t === "result"));
  await chats.configure(chatId, { model: "sonnet", mode: "plan" });
  assert.equal(fake.calls.model, "sonnet");
  const next = chats.create("w1");
  assert.ok(next.ok);
  assert.equal(next.value.model, "sonnet");
  assert.equal(next.value.mode, "bypassPermissions", "the mode comes from the setting, not the last chat");
  assert.equal(store.get().chats.length, 2);
});

const texts = (events: ChatEvent[]) => view(events).items.flatMap((i) => (i.kind === "text" ? [i.text] : []));

test("Claude's questions wait for the user's choice and pass the answers on", async () => {
  const { chats, events, chatId } = setup();
  chats.send(chatId, "ask");
  await until(() => view(events).items.some((i) => i.kind === "question"));
  const q = view(events).items.find((i) => i.kind === "question")!;
  chats.answerQuestion(chatId, q.id, { "Which colour?": "Blue" });
  await until(() => events.some((e) => e.t === "result"));
  assert.ok(texts(events).includes(`answer: {"Which colour?":"Blue"}`));
  const answered = view(events).items.find((i) => i.kind === "question");
  assert.ok(answered?.kind === "question" && answered.answered && answered.answers?.["Which colour?"] === "Blue");
});

test("replying in the chat while Claude asks answers the question in words", async () => {
  const { chats, events, chatId } = setup();
  chats.send(chatId, "ask");
  await until(() => view(events).items.some((i) => i.kind === "question"));
  chats.send(chatId, "green, actually");
  await until(() => events.some((e) => e.t === "result"));
  assert.ok(texts(events).some((t) => t.includes("replied instead") && t.includes("green, actually")));
  assert.deepEqual(view(events).queued, []);
  assert.equal(view(events).items.filter((i) => i.kind === "user").length, 2);
});

test("extra options reach the query", () => {
  const store = new Store(join(tmp, `${Math.random()}`, "state.json"));
  store.update((s) => ({
    ...s,
    features: [{ id: "w1", name: "finse", folder: tmp, createdAt: "", archived: false, port: 41000, repos: [] }],
  }));
  const fake = fakeQuery();
  const chats = new Chats(
    store,
    join(tmp, `${Math.random()}`),
    { claude: new ClaudeProvider(fake.fn, (_c, ws) => ({ allowedTools: [`x-${ws.name}`] })) },
    () => {},
  );
  const c = chats.create("w1");
  assert.ok(c.ok);
  chats.send(c.value.id, "hi");
  assert.deepEqual(fake.calls.options.allowedTools, ["x-finse"]);
  chats.stopAll();
});

test("slash commands: asked of a session that is closed again, cached per folder, Copilot has none", async () => {
  const { chatCommands } = await import("../src/main/core/agents/claude.ts");
  let started = 0;
  let closed = 0;
  const cwds: string[] = [];
  const fn = ({ options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): QueryLike =>
    Object.assign((async function* () {})(), {
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      supportedCommands: async () => (
        started++,
        cwds.push(String(options.cwd)),
        [
          { name: "copilot-review", description: "Read GitHub Copilot's PR review", argumentHint: "[pr]" },
          { name: "__internal", description: "x", argumentHint: "" },
          { name: "agents", description: "(removed) Ask Claude to manage subagents", argumentHint: "" },
          { name: "compact", description: "Free up context", argumentHint: "" },
          { name: "compact", description: "a project command of the same name", argumentHint: "" },
        ]
      ),
      close: () => void closed++,
    });
  const store = new Store(join(tmp, `${Math.random()}`, "state.json"));
  store.update((s) => ({ ...s, features: [{ id: "w1", name: "finse", folder: tmp, createdAt: "", archived: false, port: 41000, repos: [] }] }));
  const chats = new Chats(store, join(tmp, `${Math.random()}`), { claude: new ClaudeProvider(fn) }, () => {});
  const chat = chats.create("w1");
  assert.ok(chat.ok);
  const list = await chats.commands(chat.value.id);
  assert.deepEqual(list, [
    { name: "copilot-review", description: "Read GitHub Copilot's PR review", argumentHint: "[pr]" },
    { name: "compact", description: "Free up context" },
  ]);
  assert.deepEqual(cwds, [tmp], "asked where the chat works");
  assert.equal(closed, 1, "the session started only to ask is closed");
  await chats.commands(chat.value.id);
  assert.equal(started, 1, "the folder's list is cached");
  assert.deepEqual(await chats.commands("nope"), []);
  assert.deepEqual(chatCommands([]), []);
});

test("a permission request says why it asks, and what a shell command does that matters", async () => {
  const { shellEffects } = await import("../src/shared/chat.ts");
  const v = [{ t: "permission", id: "p", tool: "Bash", input: { command: "x" }, reason: "Commit requires your approval." } as ChatEvent].reduce(applyEvent, emptyView());
  assert.deepEqual(v.items[0], { kind: "permission", id: "p", tool: "Bash", input: { command: "x" }, reason: "Commit requires your approval." });
  // A script written to a file and run: what is inside still counts.
  const script = `cat > /tmp/cr2.sh <<'EOS'\nfor r in a b; do\ngit -C $r commit -q -am "fix"\ngit -C $r push -q\ngh api "repos/o/$r/pulls/1/comments/2/replies" -f body="done"\ndone\nEOS\nbash /tmp/cr2.sh`;
  assert.deepEqual(shellEffects(script), ["commits", "pushes", "posts to GitHub"]);
  assert.deepEqual(shellEffects("git -c core.pager=cat log --oneline && git status && gh pr view 3 && gh api repos/o/r/pulls/1"), [], "reading is fine");
  assert.deepEqual(shellEffects("git reset --hard origin/main; rm -rf build"), ["discards changes", "deletes files"]);
  assert.deepEqual(shellEffects("gh pr create --fill && kubectl rollout restart deploy/x"), ["changes a PR", "changes a cluster"]);
});

test("a continued chat shows the earlier conversation, with anything left open closed, above a marker", async () => {
  const { store, chats, chatId } = setup();
  chats.importHistory(
    chatId,
    [
      { t: "user", id: "u1", text: "Add a toggle", at: "2026-10-30T09:00:00Z" },
      { t: "text", id: "t1", text: "Done." },
      { t: "permission", id: "p1", tool: "Bash", input: { command: "git push" } },
    ],
    { name: "oslo", archivedAt: "2026-11-01T10:00:00Z", history: "history/01-gift-receipts.md" },
  );
  const v = view(chats.events(chatId));
  assert.deepEqual(v.items.map((i) => i.kind), ["user", "text", "permission", "continued"]);
  assert.equal((v.items[2] as { answer?: boolean }).answer, false, "the open request is closed");
  assert.deepEqual(v.items[3], { kind: "continued", id: (v.items[3] as { id: string }).id, from: "oslo", archivedAt: "2026-11-01T10:00:00Z", history: "history/01-gift-receipts.md" });
  chats.rename(chatId, "Gift receipts");
  assert.equal(store.get().chats.find((c) => c.id === chatId)?.title, "Gift receipts");
});

test("how chatty: answers and what needs the user always; notes, thinking and tools as chosen, summed up per finished turn", async () => {
  const { visibleItems, currentActivity, SHOW_ALL } = await import("../src/shared/chat.ts");
  const items = [
    { kind: "user", id: "u1", text: "Fix the test" },
    { kind: "thinking", id: "th1", text: "hmm" },
    { kind: "text", id: "t1", text: "Let me look." },
    { kind: "tool", id: "x1", name: "Bash", input: { command: "npm test" } },
    { kind: "permission", id: "p1", tool: "Bash", input: {}, answer: true },
    { kind: "text", id: "t2", text: "Fixed: the date was off by one." },
    { kind: "result", id: "r1", ok: true, durationMs: 1, turns: 1 },
    { kind: "user", id: "u2", text: "And the docs?" },
    { kind: "text", id: "t3", text: "Looking…" },
    { kind: "tool", id: "x2", name: "Read", input: { file_path: "/w/README.md" } },
  ] as ChatItem[];
  const ids = (xs: { id: string; kind: string }[]) => xs.map((x) => (x.kind === "hidden" ? `hidden(${JSON.stringify(x)})` : x.id));
  assert.equal(visibleItems(items, true, SHOW_ALL), items, "everything: as it was");
  const quiet = { notes: false, thinking: false, tools: false };
  assert.deepEqual(ids(visibleItems(items, true, quiet)), [
    "u1",
    "p1",
    `hidden(${JSON.stringify({ kind: "hidden", id: "user:u1", turn: "user:u1", notes: 1, thinking: 1, tools: 1 })})`,
    "t2",
    "r1",
    "u2",
  ], "the running turn hides its steps without a line; the working indicator tells");
  assert.deepEqual(
    ids(visibleItems(items, false, quiet)).slice(-3),
    ["u2", `hidden(${JSON.stringify({ kind: "hidden", id: "user:u2", turn: "user:u2", notes: 0, thinking: 0, tools: 1 })})`, "t3"],
    "once it ends, its last message is its answer",
  );
  assert.deepEqual(ids(visibleItems(items, true, { notes: false, thinking: true, tools: true })).slice(0, 4), ["u1", "th1", "x1", "p1"]);
  assert.deepEqual(ids(visibleItems(items, true, quiet, new Set(["user:u1"]))).slice(0, 7), ["u1", "th1", "t1", "x1", "p1", "t2", "r1"], "an opened turn shows all");
  assert.equal(currentActivity(items)?.id, "x2");
  assert.equal(currentActivity(items.slice(0, 8)), undefined, "a new turn has done nothing yet");
});

test("Claude sessions are marked as Caboose's (CABOOSE=1, the feature, the repo) for the user's hooks", async () => {
  const fake = fakeQuery();
  const store = new Store(join(tmp, `${Math.random()}`, "state.json"));
  store.update((s) => ({ ...s, features: [{ id: "w1", name: "finse", folder: tmp, createdAt: "", archived: false, port: 41000, repos: [{ name: "web", source: tmp, path: tmp, branch: "b", baseRef: "main", setup: "none" }] }] }));
  const chats = new Chats(store, join(tmp, `${Math.random()}`), { claude: new ClaudeProvider(fake.fn) }, () => {});
  const chat = chats.create("w1", undefined, "web");
  assert.ok(chat.ok);
  chats.send(chat.value.id, "hi");
  await new Promise((r) => setTimeout(r, 20));
  const env = fake.calls.options.env as Record<string, string>;
  assert.equal(env.CABOOSE, "1");
  assert.equal(env.CABOOSE_FEATURE, "finse");
  assert.equal(env.CABOOSE_REPO, "web");
  // Windows spells it "Path": process.env does not mind the case, a copied object does.
  const path = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH")!;
  assert.equal(env[path], process.env[path], "the rest of the environment is kept");
});

test("a notification says what it is about: the question, what approval is for, how the turn ended", async () => {
  const { noticeBody } = await import("../src/shared/chat.ts");
  assert.equal(
    noticeBody({ t: "question", id: "q", questions: [{ question: "Which currency should the receipt use?", header: "", options: [], multiSelect: false }] }),
    "Which currency should the receipt use?",
  );
  assert.equal(
    noticeBody({ t: "permission", id: "p", tool: "Bash", input: { command: "git push", description: "Push the fix" }, reason: "Commit requires your approval." }),
    "Wants to use Bash: Push the fix. Commit requires your approval.",
  );
  assert.equal(noticeBody({ t: "permission", id: "p", tool: "mcp__caboose__AddTodo", input: {} }), "Wants to use AddTodo");
  assert.equal(noticeBody({ t: "result", id: "r", ok: true, durationMs: 1, turns: 1 }, "Fixed: the date was off by one.\n\nDetails…"), "Fixed: the date was off by one.");
  assert.equal(noticeBody({ t: "result", id: "r", ok: false, durationMs: 1, turns: 1, error: "Credit balance too low" }), "Stopped: Credit balance too low");
});
