import { type ReactNode, useState } from "react";
import { type Drop, type Key, move, normalize, parentOf, ROOT } from "../../shared/sidebar.ts";
import type { Feature, Sidebar } from "../../shared/types.ts";
import { askText } from "./Dialog.tsx";
import { MenuButton } from "./Menu.tsx";

const api = window.caboose;
/** Features in folders you can open, close, rename and drag around (features too). */
export function FeatureTree(props: { sidebar: Sidebar; features: Feature[]; renderFeature: (f: Feature) => ReactNode }) {
  const sb = normalize(props.sidebar, props.features);
  const byId = new Map(props.features.map((f) => [f.id, f]));
  const [dragging, setDragging] = useState<Key | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const save = (next: Sidebar) => void api.saveSidebar(next);

  const count = (folder: string): number =>
    (sb.children[folder] ?? []).reduce((n, k) => n + (k.startsWith("f:") ? 1 : count(k.slice(2))), 0);

  /** Where in a row the pointer is: top/bottom edge = before/after, a folder's middle = inside. */
  const zone = (e: React.DragEvent, key: Key): Drop => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (key.startsWith("d:")) return { key, where: y < 0.25 ? "before" : y > 0.75 ? "after" : "inside" };
    return { key, where: y < 0.5 ? "before" : "after" };
  };
  const dropProps = (key: Key) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragging || dragging === key) return;
      e.preventDefault();
      e.stopPropagation();
      const z = zone(e, key);
      if (drop?.key !== z.key || drop.where !== z.where) setDrop(z);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (dragging) save(move(sb, dragging, zone(e, key)));
      setDragging(null);
      setDrop(null);
    },
  });
  const dragProps = (key: Key) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", key);
      setDragging(key);
    },
    onDragEnd: () => {
      setDragging(null);
      setDrop(null);
    },
  });
  const marker = (key: Key) => (drop && drop.key === key ? ` drop-${drop.where}` : "") + (dragging === key ? " dragging" : "");

  const renameFolder = async (id: string) => {
    const folder = sb.folders.find((d) => d.id === id)!;
    const name = await askText({ title: "Rename folder", label: "Name", value: folder.name, ok: "Rename" });
    if (name?.trim()) save({ ...sb, folders: sb.folders.map((d) => (d.id === id ? { ...d, name: name.trim() } : d)) });
  };
  const deleteFolder = (id: string) => {
    const folder = sb.folders.find((d) => d.id === id)!;
    const inside = sb.children[id] ?? [];
    if (inside.length && !confirm(`Delete the folder "${folder.name}"? What is in it moves up a level.`)) return;
    const parent = parentOf(sb, `d:${id}`) ?? ROOT;
    const children = { ...sb.children };
    const list = [...children[parent]];
    list.splice(list.indexOf(`d:${id}`), 1, ...inside);
    children[parent] = list;
    delete children[id];
    save({ folders: sb.folders.filter((d) => d.id !== id), children, collapsed: sb.collapsed.filter((c) => c !== id) });
  };

  const renderList = (parent: string, depth: number): ReactNode[] =>
    (sb.children[parent] ?? []).map((key) => {
      if (key.startsWith("f:")) {
        const f = byId.get(key.slice(2));
        if (!f) return null;
        return (
          <div key={key} className={`tree-item${marker(key)}`} style={{ paddingLeft: depth * 14 }} {...dragProps(key)} {...dropProps(key)}>
            {props.renderFeature(f)}
          </div>
        );
      }
      const id = key.slice(2);
      const folder = sb.folders.find((d) => d.id === id);
      if (!folder) return null;
      const open = !sb.collapsed.includes(id);
      return (
        <div key={key} className={`tree-folder${marker(key)}`}>
          <div
            className="folder-row"
            style={{ paddingLeft: 6 + depth * 14 }}
            {...dragProps(key)}
            {...dropProps(key)}
            onClick={() => save({ ...sb, collapsed: open ? [...sb.collapsed, id] : sb.collapsed.filter((c) => c !== id) })}
            onDoubleClick={() => void renameFolder(id)}
            title="Click to open or close, double-click to rename, drag to move"
          >
            <span className="twisty">{open ? "▾" : "▸"}</span>
            <span className="folder-name">{folder.name}</span>
            <span className="folder-count">{count(id) || ""}</span>
            <span onClick={(e) => e.stopPropagation()}>
              <MenuButton
                className="folder-menu"
                label="⋯"
                title="Folder"
                align="right"
                items={[
                  { label: "Rename…", onClick: () => void renameFolder(id) },
                  { label: "New folder inside…", onClick: () => void newFolder(id) },
                  "separator",
                  { label: "Delete folder", onClick: () => deleteFolder(id) },
                ]}
              />
            </span>
          </div>
          {open && renderList(id, depth + 1)}
        </div>
      );
    });

  /** A new folder at the top of `parent`. */
  async function newFolder(parent = ROOT) {
    const name = await askText({ title: "New folder", label: "Name", value: "", ok: "Create" });
    if (!name?.trim()) return;
    const id = crypto.randomUUID().slice(0, 8);
    const children = { ...sb.children, [id]: [], [parent]: [`d:${id}`, ...(sb.children[parent] ?? [])] };
    save({ ...sb, folders: [...sb.folders, { id, name: name.trim() }], children, collapsed: sb.collapsed.filter((c) => c !== parent) });
  }

  return (
    <div
      className={`feature-tree${drop?.key === ROOT ? " drop-end" : ""}`}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        if (drop?.key !== ROOT) setDrop({ key: ROOT, where: "end" });
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (dragging) save(move(sb, dragging, { key: ROOT, where: "end" }));
        setDragging(null);
        setDrop(null);
      }}
    >
      {renderList(ROOT, 0)}
      <button className="link new-folder" onClick={() => void newFolder()} title="A folder to group features in; drag features and folders to arrange them">
        + Folder
      </button>
    </div>
  );
}
