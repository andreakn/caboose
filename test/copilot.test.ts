// The Copilot adapter against a fake Copilot runtime: no network, no usage.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copilotEnv, CopilotProvider } from "../src/main/core/agents/copilot.ts";
import { Chats } from "../src/main/core/chats.ts";
import { Store } from "../src/main/core/store.ts";
import { applyEvent, type ChatEvent, emptyView } from "../src/shared/chat.ts";

const tmp = mkdtempSync(join(tmpdir(), "caboose-copilot-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

type Handler = (e: { type: string; data: Record<string, unknown> }) => void;

function fakeRuntime() {
  const calls = { configs: [] as any[], resumed: [] as string[], aborted: 0, modes: [] as string[], models: [] as unknown[] };
  let gate: () => void = () => {};
  class FakeSession {
    sessionId = "cp-1";
    handlers: Handler[] = [];
    config: any;
    rpc = { mode: { set: async (p: { mode: string }) => void calls.modes.push(p.mode) } };
    constructor(config: any) {
      this.config = config;
    }
    on(h: Handler) {
      this.handlers.push(h);
      return () => {};
    }
    emit(type: string, data: Record<string, unknown> = {}) {
      for (const h of this.handlers) h({ type, data });
    }
    async send({ prompt }: { prompt: string }) {
      void this.script(prompt);
      return "m";
    }
    async script(prompt: string) {
      await Promise.resolve();
      this.emit("assistant.turn_start");
      if (prompt === "slow") await new Promise<void>((r) => (gate = r));
      if (prompt === "run" || prompt === "write" || prompt === "write outside") {
        const req =
          prompt === "run"
            ? { kind: "shell", fullCommandText: "ls -la", intention: "List files", canOfferSessionApproval: true }
            : { kind: "write", fileName: prompt === "write" ? join(tmp, "a.txt") : "/etc/hosts", intention: "Edit", canOfferSessionApproval: false };
        const r = await this.config.onPermissionRequest(req, { sessionId: this.sessionId });
        this.emit("tool.execution_start", { toolCallId: `t-${prompt}`, toolName: req.kind, arguments: { x: 1 } });
        this.emit("tool.execution_complete", {
          toolCallId: `t-${prompt}`,
          success: r.kind !== "reject",
          result: { content: r.kind },
        });
      }
      if (prompt === "ask") {
        const a = await this.config.onUserInputRequest({ question: "Colour?", choices: ["Red", "Blue"] }, { sessionId: this.sessionId });
        this.emit("assistant.message", { messageId: "q", content: `answer=${a.answer} free=${a.wasFreeform}` });
      }
      this.emit("assistant.message_delta", { messageId: "m1", deltaContent: "Hel" });
      this.emit("assistant.message_delta", { messageId: "m1", deltaContent: "lo" });
      this.emit("assistant.message", { messageId: "m1", content: `Hello, you said ${prompt}` });
      this.emit("session.idle", {});
    }
    async abort() {
      calls.aborted++;
      gate();
    }
    async setModel(m: string, o: unknown) {
      calls.models.push([m, o]);
    }
    async disconnect() {}
  }
  const client = {
    start: async () => {},
    stop: async () => [],
    getAuthStatus: async () => ({ isAuthenticated: true, login: "me", authType: "gh-cli" }),
    listModels: async () => [
      { id: "gpt-x", name: "GPT X", supportedReasoningEfforts: ["low", "high"], policy: { state: "enabled" }, capabilities: {} },
      { id: "off", name: "Off", policy: { state: "disabled" }, capabilities: {} },
    ],
    createSession: async (config: any) => (calls.configs.push(config), new FakeSession(config)),
    resumeSession: async (id: string, config: any) => (calls.resumed.push(id), calls.configs.push(config), new FakeSession(config)),
  };
  return { client, calls, release: () => gate() };
}

function setup(mode: "default" | "acceptEdits" = "default") {
  const store = new Store(join(tmp, `${Math.random()}`, "state.json"));
  store.update((s) => ({
    ...s,
    workspaces: [{ id: "w1", repoId: "r", name: "finse", branch: "b", path: tmp, baseRef: "main", createdAt: "", archived: false, setup: "none" }],
  }));
  const rt = fakeRuntime();
  const provider = new CopilotProvider(() => rt.client as never, () => ({ tools: [{ name: "caboose_x" } as never], instructions: "NOTE" }));
  const events: ChatEvent[] = [];
  const chats = new Chats(store, join(tmp, `${Math.random()}`), { copilot: provider }, (_id, e) => events.push(e));
  const c = chats.create("w1", "copilot");
  assert.ok(c.ok);
  void chats.configure(c.value.id, { mode });
  return { store, chats, rt, provider, events, chatId: c.value.id };
}

const view = (events: ChatEvent[]) => events.reduce(applyEvent, emptyView());
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 400 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(fn(), "timed out");
};
const texts = (events: ChatEvent[]) => view(events).items.flatMap((i) => (i.kind === "text" ? [i.text] : []));

test("a Copilot chat streams, finishes a turn and keeps its session id", async () => {
  const { store, chats, rt, events, chatId } = setup();
  chats.send(chatId, "hi");
  await until(() => events.some((e) => e.t === "result"));
  assert.ok(events.some((e) => e.t === "draft" && e.text === "Hello"));
  assert.deepEqual(view(events).items.map((i) => i.kind), ["user", "text", "result"]);
  assert.equal(store.get().chats[0].sessionId, "cp-1");
  const config = rt.calls.configs[0];
  assert.equal(config.workingDirectory, tmp);
  assert.equal(config.streaming, true);
  assert.deepEqual(config.systemMessage, { mode: "append", content: "NOTE" });
  assert.equal(config.tools[0].name, "caboose_x");
  assert.equal(config.model, undefined);
});

test("shell commands ask first; 'always' approves for the session", async () => {
  const { chats, events, chatId } = setup();
  chats.send(chatId, "run");
  await until(() => view(events).items.some((i) => i.kind === "permission"));
  const p = view(events).items.find((i) => i.kind === "permission")!;
  assert.ok(p.kind === "permission" && p.tool === "Shell" && (p.input as { command: string }).command === "ls -la");
  chats.answerPermission(chatId, p.id, "always");
  await until(() => events.some((e) => e.t === "result"));
  const tool = view(events).items.find((i) => i.kind === "tool");
  assert.ok(tool?.kind === "tool" && tool.result?.content === "approve-for-session" && !tool.result.isError);
});

test("accept-edits approves writes inside the worktree without asking, but not outside it", async () => {
  const { chats, events, chatId } = setup("acceptEdits");
  chats.send(chatId, "write");
  await until(() => events.some((e) => e.t === "result"));
  assert.equal(view(events).items.filter((i) => i.kind === "permission").length, 0);
  chats.send(chatId, "write outside");
  await until(() => view(events).items.some((i) => i.kind === "permission"));
  const p = view(events).items.find((i) => i.kind === "permission")!;
  chats.answerPermission(chatId, p.id, "deny");
  await until(() => events.filter((e) => e.t === "result").length === 2);
  const tools = view(events).items.filter((i) => i.kind === "tool");
  assert.ok(tools[1]?.kind === "tool" && tools[1].result?.isError);
});

test("Copilot's questions use the question card, or a reply in the chat", async () => {
  const a = setup();
  a.chats.send(a.chatId, "ask");
  await until(() => view(a.events).items.some((i) => i.kind === "question"));
  const q = view(a.events).items.find((i) => i.kind === "question")!;
  assert.ok(q.kind === "question" && q.questions[0].options.map((o) => o.label).join() === "Red,Blue");
  a.chats.answerQuestion(a.chatId, q.id, { "Colour?": "Blue" });
  await until(() => a.events.some((e) => e.t === "result"));
  assert.ok(texts(a.events).includes("answer=Blue free=false"));

  const b = setup();
  b.chats.send(b.chatId, "ask");
  await until(() => view(b.events).items.some((i) => i.kind === "question"));
  b.chats.send(b.chatId, "green please");
  await until(() => b.events.some((e) => e.t === "result"));
  assert.ok(texts(b.events).includes("answer=green please free=true"));
});

test("stop aborts the turn; the next session resumes by id", async () => {
  const { store, chats, rt, events, chatId } = setup();
  chats.send(chatId, "slow");
  await until(() => view(events).running && rt.calls.configs.length === 1);
  await chats.interrupt(chatId);
  await until(() => events.some((e) => e.t === "result"));
  assert.equal(rt.calls.aborted, 1);
  const r = view(events).items.find((i) => i.kind === "result");
  assert.ok(r?.kind === "result" && !r.ok && r.error === "Interrupted");

  chats.stopAll();
  const again = new Chats(store, join(tmp, `${Math.random()}`), { copilot: new CopilotProvider(() => rt.client as never) }, () => {});
  again.send(chatId, "hi");
  await until(() => rt.calls.resumed.length === 1);
  assert.deepEqual(rt.calls.resumed, ["cp-1"]);
  again.stopAll();
});

test("models come from the plan, without disabled ones; effort only where supported", async () => {
  const { chats, rt, chatId } = setup();
  const models = await chats.models("copilot");
  assert.deepEqual(models.map((m) => m.value), ["default", "gpt-x"]);
  chats.send(chatId, "hi");
  await until(() => rt.calls.configs.length === 1);
  await chats.configure(chatId, { model: "gpt-x", effort: "high" });
  assert.deepEqual(rt.calls.models.at(-1), ["gpt-x", { reasoningEffort: "high" }]);
  await chats.configure(chatId, { effort: "max" });
  assert.deepEqual(rt.calls.models.at(-1), ["gpt-x", { reasoningEffort: undefined }]);
  await chats.configure(chatId, { mode: "plan" });
  assert.deepEqual(rt.calls.modes, ["plan"]);
  chats.stopAll();
});

test("classic tokens are hidden from the Copilot runtime, other tokens are kept", () => {
  const env = copilotEnv({ GH_TOKEN: "ghp_x", GITHUB_TOKEN: "github_pat_y", PATH: "/bin" });
  assert.deepEqual(env, { GITHUB_TOKEN: "github_pat_y", PATH: "/bin" });
});
