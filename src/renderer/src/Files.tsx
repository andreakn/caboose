import { type ReactNode, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type FileChange, type LineMarks, lineMarks, parsePatch, type WorkspaceChanges } from "../../shared/diff.ts";
import type { Feature, FeatureRepo, FileContent } from "../../shared/types.ts";

const api = window.caboose;

type Dir = { name: string; path: string; dirs: Map<string, Dir>; files: string[] };

function buildTree(files: string[]): Dir {
  const root: Dir = { name: "", path: "", dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) {
        next = { name: p, path: d.path ? `${d.path}/${p}` : p, dirs: new Map(), files: [] };
        d.dirs.set(p, next);
      }
      d = next;
    }
    d.files.push(f);
  }
  return root;
}

/** Quick-open matching: every typed character in order, closer to the file name ranks higher. */
function matches(files: string[], query: string): string[] {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const scored: [number, string][] = [];
  for (const f of files) {
    const s = f.toLowerCase();
    const name = s.slice(s.lastIndexOf("/") + 1);
    if (s.includes(q)) {
      scored.push([name.includes(q) ? 0 : 1, f]);
      continue;
    }
    let i = 0;
    for (const ch of s) if (ch === q[i]) i++;
    if (i === q.length) scored.push([2, f]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length).slice(0, 300).map(([, f]) => f);
}

const LETTER: Record<FileChange["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" };

/** Every file in a repo's worktree as a folder tree, like Conductor's, and the one you pick. */
export function FilesView(props: { f: Feature; repo: FeatureRepo; changes?: WorkspaceChanges; onShowChange: (path: string) => void }) {
  const { f, repo } = props;
  const store = `caboose-files-${f.id}-${repo.name}`;
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem(`${store}-open`) ?? "[]") as string[]));
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem(`${store}-selected`));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void api.repoFiles(f.id, repo.name).then((r) => {
      if (!live) return;
      if (r.ok) {
        setFiles(r.value.files);
        setTruncated(r.value.truncated);
        setError(null);
      } else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [f.id, repo.name, tick, props.changes]);

  const tree = useMemo(() => buildTree(files ?? []), [files]);
  const status = useMemo(() => new Map((props.changes?.files ?? []).map((c) => [c.path, c.status])), [props.changes]);
  const changedDirs = useMemo(() => {
    const s = new Set<string>();
    for (const p of status.keys()) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) s.add(p.slice(0, i));
    return s;
  }, [status]);

  const toggle = (path: string) => {
    const n = new Set(open);
    if (n.has(path)) n.delete(path);
    else n.add(path);
    setOpen(n);
    localStorage.setItem(`${store}-open`, JSON.stringify([...n]));
  };
  const pick = (path: string) => {
    setSelected(path);
    localStorage.setItem(`${store}-selected`, path);
    // Show where it is in the tree.
    const n = new Set(open);
    for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) n.add(path.slice(0, i));
    setOpen(n);
    localStorage.setItem(`${store}-open`, JSON.stringify([...n]));
  };

  const fileButton = (path: string, label: string, depth: number) => {
    const st = status.get(path);
    return (
      <button
        key={path}
        className={`tree-file${path === selected ? " active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        title={path}
        onClick={() => pick(path)}
      >
        <span className="tree-name">{label}</span>
        {st && <span className={`status st-${st}`}>{LETTER[st]}</span>}
      </button>
    );
  };

  const renderDir = (d: Dir, depth: number): ReactNode[] => [
    ...[...d.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((sub) => {
        // Folders with a single folder inside read as one line (src/main/core), as in most editors.
        let shown = sub;
        let label = sub.name;
        while (shown.files.length === 0 && shown.dirs.size === 1) {
          shown = [...shown.dirs.values()][0];
          label += `/${shown.name}`;
        }
        const isOpen = open.has(shown.path);
        return [
          <button key={shown.path} className="tree-dir" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(shown.path)} title={shown.path}>
            <span className="twisty">{isOpen ? "▾" : "▸"}</span>
            <span className="tree-name">{label}</span>
            {changedDirs.has(shown.path) && <span className="tree-changed" title="Has changes" />}
          </button>,
          ...(isOpen ? renderDir(shown, depth + 1) : []),
        ];
      }),
    ...d.files.map((p) => fileButton(p, p.slice(p.lastIndexOf("/") + 1), depth)),
  ];

  if (f.archived) return <div className="changes-empty muted">This feature is archived.</div>;
  if (error) return <div className="banner error">{error}</div>;
  if (!files) return <div className="changes-empty muted">Loading…</div>;
  const found = query.trim() ? matches(files, query.trim()) : null;

  return (
    <div className="files">
      <div className="files-side">
        <div className="files-search">
          <input value={query} placeholder={`Find a file in ${repo.name}…`} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
            if (e.key === "Escape") setQuery("");
            if (e.key === "Enter" && found?.[0]) {
              pick(found[0]);
              setQuery("");
            }
          }} />
          <button className="icon" title="Reload the file list" onClick={() => setTick((t) => t + 1)}>
            ↻
          </button>
        </div>
        <div className="tree">
          {found
            ? found.map((p) => (
                <button key={p} className={`tree-file found${p === selected ? " active" : ""}`} title={p} onClick={() => (pick(p), setQuery(""))}>
                  <span className="tree-name">{p.slice(p.lastIndexOf("/") + 1)}</span>
                  <span className="file-dir">{p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""}</span>
                  {status.get(p) && <span className={`status st-${status.get(p)}`}>{LETTER[status.get(p)!]}</span>}
                </button>
              ))
            : renderDir(tree, 0)}
          {found?.length === 0 && <div className="muted small tree-note">No file matches.</div>}
          {truncated && <div className="muted small tree-note">Showing the first 50,000 files.</div>}
        </div>
      </div>
      {selected && files.includes(selected) ? (
        <FileView key={`${selected}-${tick}`} f={f} repo={repo} path={selected} status={status.get(selected)} onShowChange={props.onShowChange} />
      ) : (
        <div className="changes-empty muted">{files.length} files. Pick one, or type to find one.</div>
      )}
    </div>
  );
}

function FileView(props: { f: Feature; repo: FeatureRepo; path: string; status?: FileChange["status"]; onShowChange: (path: string) => void }) {
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMd = /\.(md|markdown)$/i.test(props.path);
  const [preview, setPreview] = useState(isMd);
  useEffect(() => {
    void api.readRepoFile(props.f.id, props.repo.name, props.path).then((r) => (r.ok ? setContent(r.value) : setError(r.error)));
  }, [props.path]);
  // A changed file shows which lines are new or changed.
  const [marks, setMarks] = useState<LineMarks | undefined>();
  useEffect(() => {
    setMarks(undefined);
    if (!props.status || props.status === "deleted") return;
    void api.filePatch(props.f.id, props.repo.name, props.path).then((r) => r.ok && setMarks(lineMarks(parsePatch(r.value))));
  }, [props.path, props.status]);
  return (
    <div className="file-view">
      <div className="file-view-bar">
        <code title={`${props.repo.path}/${props.path}`}>{props.path}</code>
        {content && <span className="muted small">{describe(content)}</span>}
        <span className="spacer" />
        {props.status && props.status !== "untracked" && (
          <button className="small-btn" onClick={() => props.onShowChange(props.path)} title="Show what changed in this file">
            Show changes
          </button>
        )}
        {isMd && content?.kind === "text" && (
          <div className="segmented small">
            <button className={preview ? "active" : ""} onClick={() => setPreview(true)}>
              Preview
            </button>
            <button className={preview ? "" : "active"} onClick={() => setPreview(false)}>
              Source
            </button>
          </div>
        )}
        <VsCodeButton f={props.f} repo={props.repo.name} path={props.path} />
      </div>
      <ContentView path={props.path} content={content} error={error} preview={isMd && preview} marks={marks} />
    </div>
  );
}

/** "Open in VS Code" on the feature folder, at this file (and line). */
export function VsCodeButton(props: { f: Feature; repo: string; path: string; line?: number }) {
  return (
    <button
      className="small-btn"
      title={`Open the feature in VS Code, at ${props.path}${props.line ? `:${props.line}` : ""}`}
      onClick={async () => {
        const r = await api.openInVsCode(props.f.id, props.repo, props.path, props.line);
        if (!r.ok) alert(r.error);
      }}
    >
      VS Code ↗
    </button>
  );
}

/**
 * A thin bar beside the code: green for new lines, amber for changed ones, a
 * red tick where lines were removed. Positioned by line, so the code itself
 * stays one plain block however long the file is.
 */
function ChangeMarks({ marks, lines }: { marks: LineMarks; lines: number }) {
  return (
    <div className="change-marks" style={{ height: `calc(var(--code-lh) * ${lines})` }}>
      {marks.runs.map((r) => (
        <span
          key={`${r.from}-${r.kind}`}
          className={`mark ${r.kind}`}
          title={r.kind === "added" ? "New" : "Changed"}
          style={{ top: `calc(var(--code-lh) * ${r.from - 1})`, height: `calc(var(--code-lh) * ${r.to - r.from + 1})` }}
        />
      ))}
      {marks.removedBefore.map((n) => (
        <span key={`d${n}`} className="mark removed" title="Lines removed here" style={{ top: `calc(var(--code-lh) * ${n - 1} - 3px)` }} />
      ))}
    </div>
  );
}

/** "1.2 KB · 40 lines" */
export function describe(content: FileContent): string {
  const lines = content.kind === "text" ? content.text.split("\n").length - (content.text.endsWith("\n") ? 1 : 0) : 0;
  return `${size(content.size)}${content.kind === "text" ? ` · ${lines} lines` : ""}`;
}

/** A file's contents: text with line numbers (or markdown rendered), an image, or why it is not shown. */
export function ContentView(props: {
  path: string;
  content: FileContent | null | undefined;
  error?: string | null;
  preview?: boolean;
  missing?: string;
  /** New and changed lines, and where lines were removed (against the branch's base). */
  marks?: LineMarks;
}) {
  const { content, error } = props;
  if (error) return <div className="banner error">{error}</div>;
  if (content === null) return <div className="changes-empty muted">{props.missing ?? "No such file."}</div>;
  if (!content) return <div className="changes-empty muted">Loading…</div>;
  if (content.kind === "binary") return <div className="changes-empty muted">A binary file.</div>;
  if (content.kind === "tooLarge") return <div className="changes-empty muted">Too large to show ({size(content.size)}).</div>;
  if (content.kind === "image")
    return (
      <div className="file-image">
        <img src={content.dataUrl} alt={props.path} />
      </div>
    );
  if (props.preview)
    return (
      <div className="file-md md">
        <Markdown remarkPlugins={[remarkGfm]}>{content.text}</Markdown>
      </div>
    );
  const lines = content.text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return (
    <div className="file-code">
      <div className="gutter-wrap">
        <pre className="gutter">{lines.map((_, i) => i + 1).join("\n")}</pre>
        {props.marks && <ChangeMarks marks={props.marks} lines={lines.length} />}
      </div>
      <pre className="code">{lines.join("\n")}</pre>
    </div>
  );
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
