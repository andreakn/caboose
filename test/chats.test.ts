// Chats against a fake SDK query(), so no Claude usage and no network.
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { applyEvent, type ChatEvent, emptyView } from "../src/shared/chat.ts";
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
