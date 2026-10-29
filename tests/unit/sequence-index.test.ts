import { expect, test } from "@lightning-js/lightning";
import { SequenceIndex, ORDER_CHUNK_MAX, type OrderEntry } from "../../src/history/sequence-index.js";
import { ordinalId, START, END, FugueSequence } from "../../src/history/sequence.js";
import { createRoot } from "../../src/history/identity.js";
import { documentId, externalBaseId } from "../../src/identity.js";

function value(id: string, scalar = "x", visible = true): OrderEntry {
  return Object.freeze({ key: `${id}=`, element: Object.freeze({ id, scalar, visible, transaction: null, actor: null }) });
}

test("chunk order index locates identities and visible/full prefixes through edits and tombstones", () => {
  const original = SequenceIndex.from(Array.from({ length: 2000 }, (_, i) => value(`id:${i}`, i % 2 ? "😀" : "x")));
  let index = original;
  const oracle = [...original.entries()];
  let seed = 424242;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = 0; i < 200; i++) {
    const at = random() % (oracle.length + 1);
    const removed = at < oracle.length && random() % 2 ? 1 : 0;
    const added = i % 4 ? [value(`new:${i}`, "中", i % 3 !== 0)] : [];
    index = index.splice(at, removed, added);
    oracle.splice(at, removed, ...added);
    expect([...index.entries()]).toEqual(oracle);
    let visible = 0;
    for (let j = 0; j < oracle.length; j++) {
      const entry = oracle[j]!;
      const found = index.locate(entry.key)!;
      expect(found.before.entries).toBe(j);
      expect(found.before.full).toBe(j);
      expect(found.before.visible).toBe(visible);
      expect(found.entry).toBe(entry);
      if (entry.element?.visible) {
        expect(index.visibleAt(visible)).toBe(entry.element.id);
        visible++;
      }
    }
    expect(index.summary.visible).toBe(visible);
    expect(index.visibleAt(visible)).toBe(undefined);
    expect(index.locate("absent")).toBe(undefined);
    const root = index.debugRoots().order;
    let parents = 0;
    let chunks = 0;
    const visit = (node: NonNullable<typeof root>) => {
      parents++;
      if (node.kind === "branch") for (const child of node.children) visit(child);
      else for (const chunk of node.items) {
        chunks++;
        expect(chunk.entries.length <= ORDER_CHUNK_MAX && chunk.entries.length >= ORDER_CHUNK_MAX / 2).toBe(true);
      }
    };
    if (root) visit(root);
    expect(index.debugSizes()).toEqual({ identities: oracle.length, chunks, parents });
  }
  expect([...original.entries()].length).toBe(2000);
  expect(original.summary.visible).toBe(2000);
});

test("persistent Fugue staging retains tombstones and uses subtree boundaries rather than walking chains", () => {
  const root = createRoot({ document: documentId("index"), base: externalBaseId("base"), text: "abc" });
  const original = new FugueSequence(root);
  const staged = original.clone();
  const a = ordinalId(root.id, 0);
  const b = ordinalId(root.id, 1);
  staged.delete([b]);
  expect(staged.gap(a)).toEqual({ right: b, parent: b, side: "L" });
  staged.add({ kind: "insert", id: "test/1", scalar: "😀", left: a, right: b, parent: b, side: "L" }, null, null);
  expect(staged.text.toString()).toBe("a😀c");
  expect(original.text.toString()).toBe("abc");
  expect(staged.order.guard(b)).toEqual({ before: 2, visible: false });
  expect(staged.order.visibleAt(1)).toBe("test/1");
  expect(staged.order.fullAt(2)?.id).toBe(b);
  expect(staged.gap(ordinalId(root.id, 2))).toEqual({ parent: ordinalId(root.id, 2), side: "R", right: END });
  expect(original.gap(START).right).toBe(a);
});

test("batch visibility updates retain full order, exact Unicode summaries and live-only locators", () => {
  const original = SequenceIndex.from(Array.from({ length: 10_000 }, (_, i) => value(`id:${i}`, i % 2 ? "😀" : "x")));
  const targets = Array.from({ length: 10_000 }, (_, i) => `id:${i}`);
  const hidden = original.hide(targets);
  expect(hidden.summary.visible).toBe(0);
  expect(hidden.summary.full).toBe(10_000);
  expect(hidden.summary.utf16).toBe(0);
  expect(hidden.summary.utf8).toBe(0);
  expect(original.summary.utf16).toBe(15_000);
  expect(original.summary.utf8).toBe(25_000);
  expect(hidden.fullAt(9999)?.id).toBe("id:9999");
  expect(hidden.guard("id:9999")).toEqual({ before: 0, visible: false });
  expect([...hidden.visibleRange(0, 0)]).toEqual([]);
  expect(hidden.debugSizes()).toEqual(original.debugSizes());
  expect(hidden.setVisibility([{ id: "id:1", visible: true }, { id: "id:1", visible: false }])).toBe(hidden);
  const restored = hidden.setVisibility([{ id: "id:1", visible: false }, { id: "id:1", visible: true }]);
  expect(restored.summary.visible).toBe(1);
  expect(restored.summary.utf16).toBe(2);
  expect(restored.summary.utf8).toBe(4);
  expect(hidden.hide(targets)).toBe(hidden);
  expect(() => hidden.hide(["unknown"])).toThrow("INVALID_REFERENCE");
  expect(() => hidden.splice(0, 0, [value("id:1")])).toThrow("INVALID_REFERENCE");
  const empty = hidden.splice(0, 10_000, []);
  expect(empty.debugSizes()).toEqual({ identities: 0, chunks: 0, parents: 0 });
  expect(empty.splice(0, 0, [value("new")]).guard("new")).toEqual({ before: 0, visible: true });
});
