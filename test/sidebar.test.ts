// The sidebar's folders: fitting the layout to the features there are, and moving things around.
import assert from "node:assert/strict";
import { test } from "node:test";
import { featureOrder, move, normalize } from "../src/shared/sidebar.ts";
import type { Feature, Sidebar } from "../src/shared/types.ts";

const f = (id: string) => ({ id }) as Feature;
const base: Sidebar = {
  folders: [{ id: "work", name: "Work" }, { id: "abc", name: "ABC" }],
  children: { root: ["d:work", "f:a"], work: ["d:abc", "f:b"], abc: ["f:c", "f:gone"] },
  collapsed: ["abc", "deleted-folder"],
};

test("the saved layout fits the features there are: ended ones drop out, new ones join the top level", () => {
  const sb = normalize(base, [f("a"), f("b"), f("c"), f("new")]);
  assert.deepEqual(sb.children, { root: ["d:work", "f:a", "f:new"], work: ["d:abc", "f:b"], abc: ["f:c"] });
  assert.deepEqual(sb.collapsed, ["abc"]);
  assert.deepEqual(featureOrder(sb), ["c", "b", "a", "new"], "depth first, in the order shown");
  assert.deepEqual(normalize({ folders: [], children: {}, collapsed: [] }, [f("x"), f("y")]).children, { root: ["f:x", "f:y"] });
});

test("moving: before, after, into a folder, to the end", () => {
  const sb = normalize(base, [f("a"), f("b"), f("c")]);
  assert.deepEqual(move(sb, "f:a", { key: "f:b", where: "before" }).children, { root: ["d:work"], work: ["d:abc", "f:a", "f:b"], abc: ["f:c"] });
  assert.deepEqual(move(sb, "f:c", { key: "d:work", where: "after" }).children.root, ["d:work", "f:c", "f:a"]);
  const into = move(sb, "f:a", { key: "d:abc", where: "inside" });
  assert.deepEqual(into.children.abc, ["f:c", "f:a"]);
  assert.deepEqual(into.collapsed, [], "dropping into a closed folder opens it");
  assert.deepEqual(move(sb, "d:abc", { key: "root", where: "end" }).children, { root: ["d:work", "f:a", "d:abc"], work: ["f:b"], abc: ["f:c"] });
});

test("a folder cannot go inside itself or its own subfolder", () => {
  const sb = normalize(base, [f("a"), f("b"), f("c")]);
  assert.equal(move(sb, "d:work", { key: "d:abc", where: "inside" }), sb);
  assert.equal(move(sb, "d:work", { key: "d:work", where: "inside" }), sb);
  assert.equal(move(sb, "d:work", { key: "f:c", where: "before" }), sb, "f:c lives inside work/abc");
});
