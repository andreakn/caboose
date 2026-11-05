// GitHub Copilot through the official Copilot SDK, which runs the Copilot CLI
// runtime (bundled per OS by npm) under the user's own GitHub login: the
// Copilot CLI's own, or the GitHub CLI's (gh auth login). One runtime process
// serves every Copilot chat.
import type { CopilotClient, CopilotSession, ModelInfo, PermissionRequest, PermissionRequestResult, SessionConfig, Tool } from "@github/copilot-sdk";
import { isAbsolute, relative } from "node:path";
import type { Chat, Mode, ModelOption } from "../../../shared/chat.ts";
import type { Workspace } from "../../../shared/types.ts";
import { type AgentHost, type AgentProvider, type AgentSession, clip, errorText } from "./types.ts";

/** Caboose's tools and system-prompt note for one chat. */
export type CopilotExtras = (chat: Chat, ws: Workspace) => { tools: Tool[]; instructions: string };

export type CopilotAuth = { ok: boolean; detail: string };

export class CopilotProvider implements AgentProvider {
  private makeClient: () => CopilotClient;
  private extras: CopilotExtras;
  private client?: Promise<CopilotClient>;
  private modelInfo = new Map<string, ModelInfo>();

  constructor(makeClient: () => CopilotClient, extras: CopilotExtras = () => ({ tools: [], instructions: "" })) {
    this.makeClient = makeClient;
    this.extras = extras;
  }

  /** Starts the runtime on first use; a failed start is retried next time. */
  private getClient(): Promise<CopilotClient> {
    this.client ??= (async () => {
      const c = this.makeClient();
      await c.start();
      return c;
    })().catch((e) => {
      this.client = undefined;
      throw e;
    });
    return this.client;
  }

  async auth(): Promise<CopilotAuth> {
    const a = await (await this.getClient()).getAuthStatus();
    return a.isAuthenticated
      ? { ok: true, detail: `logged in${a.login ? ` as ${a.login}` : ""}${a.authType ? ` (${a.authType})` : ""}` }
      : { ok: false, detail: a.statusMessage ?? "not logged in" };
  }

  async models(): Promise<ModelOption[]> {
    const list = await (await this.getClient()).listModels();
    for (const m of list) this.modelInfo.set(m.id, m);
    return [
      { value: "default", label: "Default model" },
      ...list
        .filter((m) => m.policy?.state !== "disabled")
        .map((m) => ({ value: m.id, label: m.name || m.id, efforts: m.supportedReasoningEfforts })),
    ];
  }

  async stop(): Promise<void> {
    const c = await this.client?.catch(() => undefined);
    this.client = undefined;
    await c?.stop();
  }

  start(chat: Chat, ws: Workspace, host: AgentHost): AgentSession {
    let session: CopilotSession | undefined;
    let closed = false;
    let mode: Mode = chat.mode;
    // Model and effort as the session has them now (the chat object is a snapshot).
    let model = chat.model;
    let effort = chat.effort;
    const outbox: string[] = [];
    // The turn in progress: when it started, how many model turns, the last error.
    let turn: { started: number; turns: number; error?: string; aborted?: boolean } | undefined;
    const drafts = new Map<string, string>();

    /** The effort to ask for, if the model supports it. */
    const effortFor = (m: string) =>
      this.modelInfo.get(m)?.supportedReasoningEfforts?.includes(effort) ? effort : undefined;

    const ready = (async () => {
      const client = await this.getClient();
      if (!this.modelInfo.size) await this.models().catch(() => {});
      const { tools, instructions } = this.extras(chat, ws);
      const config: SessionConfig = {
        clientName: "Caboose",
        workingDirectory: ws.path,
        model: model === "default" ? undefined : model,
        reasoningEffort: model === "default" ? undefined : effortFor(model),
        streaming: true,
        tools,
        systemMessage: { mode: "append", content: instructions },
        onPermissionRequest: async (req) => decide(req, mode, ws, host),
        onUserInputRequest: async (req) => {
          const answer = await host.askQuestions([
            {
              question: req.question,
              header: "Question",
              options: (req.choices ?? []).map((label) => ({ label, description: "" })),
              multiSelect: false,
            },
          ]);
          if (answer && "repliedInChat" in answer) return { answer: answer.repliedInChat, wasFreeform: true };
          if (!answer) return { answer: "(The user dismissed the question without answering.)", wasFreeform: true };
          const text = answer[req.question] ?? "";
          return { answer: text, wasFreeform: !(req.choices ?? []).includes(text) };
        },
      };
      const s = chat.sessionId
        ? await client.resumeSession(chat.sessionId, config).catch(() => client.createSession(config))
        : await client.createSession(config);
      if (closed) {
        void s.disconnect();
        return;
      }
      session = s;
      host.sessionId(s.sessionId);
      if (mode === "plan") await s.rpc.mode.set({ mode: "plan" }).catch(() => {});
      s.on((e) => {
        const data = e.data as Record<string, unknown>;
        if (data?.parentToolCallId) return; // sub-agents' own steps
        switch (e.type) {
          case "assistant.turn_start":
            if (turn) turn.turns++;
            break;
          case "assistant.message_delta":
          case "assistant.reasoning_delta": {
            const kind = e.type === "assistant.message_delta" ? "text" : "thinking";
            const key = `${kind}:${e.type === "assistant.message_delta" ? e.data.messageId : e.data.reasoningId}`;
            const text = (drafts.get(key) ?? "") + e.data.deltaContent;
            drafts.set(key, text);
            host.draft(kind, text);
            break;
          }
          case "assistant.reasoning":
            if (e.data.content.trim()) host.thinking(e.data.reasoningId, e.data.content);
            break;
          case "assistant.message":
            if (e.data.content.trim()) host.text(e.data.messageId, e.data.content);
            break;
          case "tool.execution_start":
            host.tool(e.data.toolCallId, e.data.toolName, e.data.arguments ?? {});
            break;
          case "tool.execution_complete":
            host.toolResult(
              e.data.toolCallId,
              clip(e.data.result?.content ?? e.data.error?.message ?? ""),
              !e.data.success,
            );
            break;
          case "session.error":
            if (turn) turn.error = e.data.message;
            else host.ended(e.data.message);
            break;
          case "session.idle":
            if (!turn) break;
            drafts.clear();
            host.turnEnd({
              ok: !turn.error && !turn.aborted && !e.data.aborted,
              durationMs: Date.now() - turn.started,
              turns: Math.max(1, turn.turns),
              error: turn.error ?? (turn.aborted || e.data.aborted ? "Interrupted" : undefined),
            });
            turn = undefined;
            break;
        }
      });
      for (const text of outbox.splice(0)) send(text);
    })().catch((e) => {
      if (!closed) host.ended(`Copilot could not start: ${errorText(e)}`);
    });

    function send(text: string) {
      if (!session) {
        outbox.push(text);
        return;
      }
      turn = { started: Date.now(), turns: 0 };
      session.send({ prompt: text }).catch((e) => {
        if (turn) {
          host.turnEnd({ ok: false, durationMs: Date.now() - turn.started, turns: 0, error: errorText(e) });
          turn = undefined;
        }
      });
    }

    return {
      send,
      interrupt: async () => {
        if (turn) turn.aborted = true;
        await ready;
        await session?.abort();
      },
      configure: async (patch) => {
        await ready;
        if (patch.mode) {
          mode = patch.mode;
          await session?.rpc.mode.set({ mode: mode === "plan" ? "plan" : "interactive" });
        }
        if (patch.effort) effort = patch.effort;
        if (patch.model) model = patch.model;
        if ((patch.model || patch.effort) && model !== "default") {
          await session?.setModel(model, { reasoningEffort: effortFor(model) });
        }
      },
      close: () => {
        closed = true;
        void session?.disconnect().catch(() => {});
      },
    };
  }
}

/** Applies the chat's permission mode, asking the user where it says to. */
async function decide(req: PermissionRequest, mode: Mode, ws: Workspace, host: AgentHost): Promise<PermissionRequestResult> {
  const inside = (p?: string) => {
    if (!p) return false;
    const rel = relative(ws.path, isAbsolute(p) ? p : `${ws.path}/${p}`);
    return !rel.startsWith("..") && !isAbsolute(rel);
  };
  const auto =
    mode === "bypassPermissions" ||
    (req.kind === "read" && inside(req.path)) ||
    (mode === "acceptEdits" && req.kind === "write" && inside(req.fileName));
  if (auto) return { kind: "approve-once" };

  const { tool, input } = describe(req);
  const answer = await host.askPermission(tool, input);
  if (answer === "deny") return { kind: "reject", feedback: "The user said no." };
  if (answer === "always" && "canOfferSessionApproval" in req && req.canOfferSessionApproval) {
    return { kind: "approve-for-session" };
  }
  return { kind: "approve-once" };
}

/** A permission request as a tool name and input the approval card understands. */
function describe(req: PermissionRequest): { tool: string; input: unknown } {
  switch (req.kind) {
    case "shell":
      return { tool: "Shell", input: { command: req.fullCommandText, description: req.intention } };
    case "write":
      return { tool: "Write", input: { file_path: req.fileName, description: req.intention } };
    case "read":
      return { tool: "Read", input: { file_path: req.path, description: req.intention } };
    case "url":
      return { tool: "Fetch", input: { url: req.url, description: req.intention } };
    case "mcp":
      return { tool: `mcp__${req.serverName}__${req.toolName}`, input: req.args ?? {} };
    case "custom-tool":
      return { tool: req.toolName, input: req.args ?? {} };
    default:
      return { tool: req.kind, input: req };
  }
}

/**
 * The environment for the Copilot runtime. Classic personal access tokens
 * (ghp_) in GH_TOKEN/GITHUB_TOKEN are left out: Copilot rejects them, and they
 * would hide the user's real login (gh's keyring or the Copilot CLI's own).
 */
export function copilotEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const out = { ...env };
  for (const k of ["GH_TOKEN", "GITHUB_TOKEN"]) if (out[k]?.startsWith("ghp_")) delete out[k];
  return out;
}
