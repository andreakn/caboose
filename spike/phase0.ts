// Phase 0: prove the Agent SDK runs Claude Code under the user's own login.
// Run: npm run spike   (works the same on macOS and Windows)
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "caboose-spike-"));

const q = query({
  prompt: "Create a file hello.txt containing exactly 'all aboard', then read it back and tell me what it says.",
  options: { cwd: dir, model: "haiku", permissionMode: "acceptEdits", maxTurns: 6 },
});

const account = await q.accountInfo();
console.log("account:", {
  subscription: account.subscriptionType,
  tokenSource: account.tokenSource,
  apiKeySource: account.apiKeySource,
  provider: account.apiProvider,
});

for await (const m of q) {
  if (m.type === "system" && m.subtype === "init") {
    console.log(`init: claude ${m.claude_code_version}, model ${m.model}, apiKeySource ${m.apiKeySource}`);
  } else if (m.type === "assistant") {
    for (const b of m.message.content) {
      if (b.type === "text") console.log("claude:", b.text);
      if (b.type === "tool_use") console.log(`tool: ${b.name}`, JSON.stringify(b.input));
    }
  } else if (m.type === "result") {
    console.log(`result: ${m.subtype}, ${m.num_turns} turns, ${m.duration_ms} ms`);
  }
}

console.log("hello.txt on disk:", JSON.stringify(readFileSync(join(dir, "hello.txt"), "utf8").trim()));
rmSync(dir, { recursive: true, force: true });
