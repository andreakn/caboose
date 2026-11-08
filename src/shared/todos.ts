// The user's to-do list: steps only the user can do (run a migration in an
// environment, set a secret, click something in a console), written down by
// the agents (AddTodo) or by the user. Plain markdown in the feature folder,
// todo.md, so agents read it like the other files:
//
//   - [ ] [orders] Run the orders migration on test <!-- from: orders -->
//     The new column must exist before the deploy.
//     ```sh
//     npm run migrate -- --env test
//     ```
//
// "[repo]" says which repo it is about; the details are the indented lines
// under it (markdown); the comment says which chat asked (a repo, or "feature").
import type { TodoItem } from "./types.ts";

const ITEM_RE = /^[-*] \[( |x|X)\] (.*)$/;
const FROM_RE = /\s*<!--\s*from:\s*([^>]*?)\s*-->\s*$/;
const REPO_RE = /^\[([^\]]+)\]\s+/;

export function parseTodos(markdown: string): TodoItem[] {
  const lines = markdown.split("\n");
  const items: TodoItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ITEM_RE.exec(lines[i]);
    if (!m) continue;
    let title = m[2];
    const from = FROM_RE.exec(title)?.[1];
    title = title.replace(FROM_RE, "");
    const repo = REPO_RE.exec(title)?.[1];
    title = title.replace(REPO_RE, "").trim();
    const details: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") {
        details.push("");
        continue;
      }
      if (!/^\s{2,}/.test(l)) break;
      details.push(l.replace(/^ {2}/, ""));
    }
    while (details.length && details.at(-1) === "") details.pop();
    items.push({ line: i, done: m[1] !== " ", title, ...(repo ? { repo } : {}), ...(from ? { from } : {}), ...(details.length ? { details: details.join("\n") } : {}) });
    i = j - 1;
  }
  return items;
}

/** One item as markdown, ready to append. */
export function formatTodo(t: { title: string; details?: string; repo?: string; from?: string }): string {
  const title = t.title.replace(/\s+/g, " ").trim();
  const head = `- [ ] ${t.repo ? `[${t.repo}] ` : ""}${title}${t.from ? ` <!-- from: ${t.from} -->` : ""}`;
  const body = t.details?.trim() ? `\n${t.details.trim().split("\n").map((l) => (l ? `  ${l}` : "")).join("\n")}` : "";
  return `${head}${body}\n`;
}
