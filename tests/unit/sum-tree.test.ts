import { expect, test } from "@lightning-js/lightning";
import {
  SumTree, TREE_MAX, TREE_MIN, type SumNode, type SummaryOps,
} from "../../src/collections/sum-tree.js";

interface Totals { readonly count: number; readonly weight: number }
const ops: SummaryOps<number, Totals> = Object.freeze({
  empty: Object.freeze({ count: 0, weight: 0 }),
  measure: (value: number): Totals => Object.freeze({ count: 1, weight: value }),
  add: (a: Totals, b: Totals): Totals => Object.freeze({ count: a.count + b.count, weight: a.weight + b.weight }),
});
function nodes<T, S>(root: SumNode<T, S> | null): Set<SumNode<T, S>> {
  const result = new Set<SumNode<T, S>>();
  if (!root) return result;
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    result.add(node);
    if (node.kind === "branch") for (const child of node.children) pending.push(child);
  }
  return result;
}
function audit(tree: SumTree<number, Totals>, expected: readonly number[]): void {
  const visit = (node: SumNode<number, Totals>, root: boolean): Totals => {
    expect(Object.isFrozen(node)).toBe(true);
    const size = node.kind === "leaf" ? node.items.length : node.children.length;
    expect(size <= TREE_MAX && size >= (root ? node.kind === "leaf" ? 1 : 2 : TREE_MIN)).toBe(true);
    let totals = ops.empty;
    if (node.kind === "leaf") {
      expect(node.height).toBe(0);
      expect(Object.isFrozen(node.items)).toBe(true);
      node.items.forEach((item, i) => {
        expect(node.itemSummaries[i]).toEqual(ops.measure(item));
        totals = ops.add(totals, ops.measure(item));
      });
    } else {
      expect(Object.isFrozen(node.children)).toBe(true);
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!;
        expect(child.height).toBe(node.height - 1);
        const summary = visit(child, false);
        expect(node.childSummaries[i]).toEqual(summary);
        totals = ops.add(totals, summary);
      }
    }
    expect(node.count).toBe(totals.count);
    expect(node.summary).toEqual(totals);
    return totals;
  };
  const root = tree.debugRoot();
  if (root) visit(root, true);
  else expect(expected.length).toBe(0);
  expect([...tree]).toEqual(expected);
  expect(tree.length).toBe(expected.length);
  expect(tree.summary).toEqual({ count: expected.length, weight: expected.reduce((a, b) => a + b, 0) });
}

test("B+ construction obeys occupancy, equal leaf depth and exact item/child summaries", () => {
  for (const size of [0, 1, 7, 8, 15, 16, 17, 31, 32, 127, 256, 257, 4097]) {
    const values = Array.from({ length: size }, (_, i) => i % 7);
    audit(SumTree.from(values, ops), values);
  }
});

test("B+ split and concatenate repair underfull boundaries without flattening the tree", () => {
  const values = Array.from({ length: 1001 }, (_, i) => i % 11);
  const tree = SumTree.from(values, ops);
  for (const offset of [0, 1, 7, 8, 15, 16, 17, 127, 128, 129, 500, 990, 1000, 1001]) {
    const [left, right] = tree.split(offset);
    audit(left, values.slice(0, offset));
    audit(right, values.slice(offset));
    audit(left.concat(right), values);
    audit(right.concat(left), [...values.slice(offset), ...values.slice(0, offset)]);
  }
  const large = SumTree.from(Array.from({ length: 9000 }, () => 1), ops);
  audit(tree.concat(large), [...values, ...Array.from({ length: 9000 }, () => 1)]);
});

test("B+ splices retain old roots and share unaffected subtrees with bounded path copying", () => {
  const values = Array.from({ length: 100_000 }, (_, i) => i % 5);
  const tree = SumTree.from(values, ops);
  const changed = tree.splice(50_000, 1, [99]);
  const oldNodes = nodes(tree.debugRoot());
  const newNodes = nodes(changed.debugRoot());
  const shared = [...newNodes].filter((node) => oldNodes.has(node)).length;
  expect(shared > oldNodes.size * 0.95).toBe(true);
  expect(newNodes.size - shared < 100).toBe(true);
  expect(tree.at(50_000)).toBe(values[50_000]);
  expect(changed.at(50_000)).toBe(99);
  expect(tree.splice(0, 0, []).debugRoot()).toBe(tree.debugRoot());
  audit(changed, [...values.slice(0, 50_000), 99, ...values.slice(50_001)]);
  audit(changed.slice(49_990, 50_010), [...values.slice(49_990, 50_000), 99, ...values.slice(50_001, 50_010)]);
  let visits = 0;
  const cursor = tree.cursor((summary) => { visits++; return summary.count; });
  visits = 0;
  cursor.seek(50_000);
  expect(cursor.item).toBe(values[50_000]);
  expect(visits <= TREE_MAX * (tree.debugRoot()!.height + 1) + 1).toBe(true);
});

test("dimension cursors seek with explicit bias and accumulate every summary field", () => {
  const values = Array.from({ length: 100 }, (_, i) => i % 4);
  const tree = SumTree.from(values, ops);
  const cursor = tree.cursor((summary) => summary.weight);
  for (let target = 0; target <= tree.summary.weight; target++) {
    for (const bias of ["left", "right"] as const) {
      let prefix = 0;
      const index = values.findIndex((value) => {
        prefix += value;
        return bias === "left" ? prefix >= target : prefix > target;
      });
      cursor.seek(target, bias);
      const expected = index < 0 ? values.length : index;
      expect(cursor.index).toBe(expected);
      expect(cursor.item).toBe(values[expected]);
      expect(cursor.before).toEqual({
        count: expected, weight: values.slice(0, expected).reduce((a, b) => a + b, 0),
      });
    }
  }
  cursor.seek(0, "left");
  const traversed: number[] = [];
  while (!cursor.done) { traversed.push(cursor.item!); cursor.next(); }
  expect(traversed).toEqual(values);
  expect(cursor.before).toEqual(tree.summary);
  expect(() => cursor.seek(-1)).toThrow("INVALID_RANGE");
  expect(() => tree.split(101)).toThrow("INVALID_RANGE");
  expect(() => tree.slice(3, 2)).toThrow("INVALID_RANGE");
  expect(() => tree.concat(SumTree.from([1], { ...ops }))).toThrow("INVALID_REFERENCE");
  const absent: SummaryOps<undefined, number> = { empty: 0, measure: () => 1, add: (a, b) => a + b };
  const undefinedItems = SumTree.from([undefined, undefined], absent).cursor((count) => count);
  expect(undefinedItems.item).toBe(undefined);
  expect(undefinedItems.done).toBe(false);
  undefinedItems.next();
  expect(undefinedItems.done).toBe(false);
  undefinedItems.next();
  expect(undefinedItems.done).toBe(true);
});

test("B+ summaries preserve noncommutative order and randomized splice invariants", () => {
  const words: SummaryOps<string, string> = { empty: "", measure: (value) => value, add: (a, b) => a + b };
  const text = SumTree.from(["A", "B", "C"], words).splice(1, 1, ["x", "y"]);
  expect(text.summary).toBe("AxyC");
  let tree = SumTree.from<number, Totals>([], ops);
  let values: number[] = [];
  let state = 0x816ab23;
  const next = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
  for (let step = 0; step < 600; step++) {
    const start = next(values.length + 1);
    const removed = next(Math.min(19, values.length - start) + 1);
    const inserted = Array.from({ length: next(24) }, () => next(9));
    tree = tree.splice(start, removed, inserted);
    values.splice(start, removed, ...inserted);
    audit(tree, values);
  }
});
