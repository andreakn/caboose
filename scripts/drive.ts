// Drives a running Caboose over the Chrome DevTools protocol, to check UI changes for real.
// Start the app with: CABOOSE_DATA=<dir> npx electron . --remote-debugging-port=9333
// Then: node scripts/drive.ts 9333 steps.json
// script: [{ "eval": "js" } | { "wait": ms } | { "shot": "file.png" } | { "until": "js", "timeout": ms }]
import { readFileSync, writeFileSync } from "node:fs";

const [port, scriptFile] = process.argv.slice(2);
const steps = JSON.parse(readFileSync(scriptFile, "utf8"));
let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
for (let i = 0; i < 100 && !targets.some((t) => t.type === "page"); i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}
const ws = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map<number, (v: any) => void>();
ws.addEventListener("message", (m) => {
  const msg = JSON.parse(String(m.data));
  pending.get(msg.id)?.(msg);
});
const call = (method: string, params: object = {}) =>
  new Promise<any>((r) => {
    const id = ++seq;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression: string) => {
  const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
await new Promise((r) => setTimeout(r, 1500));
for (const s of steps) {
  if (s.eval) console.log("eval →", JSON.stringify(await evaluate(s.eval))?.slice(0, 300));
  if (s.wait) await new Promise((r) => setTimeout(r, s.wait));
  if (s.until) {
    const end = Date.now() + (s.timeout ?? 30000);
    while (!(await evaluate(s.until))) {
      if (Date.now() > end) throw new Error(`timed out: ${s.until}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (s.shot) {
    const r = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(s.shot, Buffer.from(r.result.data, "base64"));
    console.log("shot →", s.shot);
  }
}
ws.close();
process.exit(0);
