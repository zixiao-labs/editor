import { expect, test } from "@lightning-js/lightning";
import { OrderedMap } from "../../src/collections/ordered-map.js";
import { SumTree } from "../../src/collections/sum-tree.js";

test("B+ ordered map preserves previous versions across replacements, inserts and deletes", () => {
  let map = OrderedMap.from<number, number>();
  const oracle = new Map<number, number>();
  let seed = 424242;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const saved: { map: OrderedMap<number, number>; entries: Map<number, number> }[] = [];
  for (let i = 0; i < 1000; i++) {
    const key = random() % 130;
    if (random() % 3) { map = map.set(key, i); oracle.set(key, i); }
    else { map = map.delete(key); oracle.delete(key); }
    if (i % 100 === 0) saved.push({ map, entries: new Map(oracle) });
    expect(map.size).toBe(oracle.size);
    for (let key = 0; key < 130; key++) {
      expect(map.get(key)).toBe(oracle.get(key));
      expect(map.has(key)).toBe(oracle.has(key));
    }
  }
  for (const version of saved) for (let key = 0; key < 130; key++) {
    expect(version.map.get(key)).toBe(version.entries.get(key));
  }
  const undefinedValue = OrderedMap.from<string, undefined>([["x", undefined]]);
  expect(undefinedValue.has("x")).toBe(true);
  expect(undefinedValue.has("y")).toBe(false);
  expect(undefinedValue.delete("missing")).toBe(undefinedValue);
});

test("prefix-predicate seek supports nonnumeric keys and full prefix summaries", () => {
  const tree = SumTree.from(["alpha", "beta", "gamma"], {
    empty: { last: "", count: 0 },
    measure: (last: string) => ({ last, count: 1 }),
    add: (a, b) => ({ last: b.last || a.last, count: a.count + b.count }),
  });
  const cursor = tree.cursor((s) => s.count);
  cursor.seekBy((s) => s.last >= "b");
  expect(cursor.item).toBe("beta");
  expect(cursor.before).toEqual({ last: "alpha", count: 1 });
  cursor.next();
  expect(cursor.item).toBe("gamma");
  cursor.seekBy((s) => s.last >= "z");
  expect(cursor.done).toBe(true);
  expect(cursor.before).toEqual(tree.summary);
});

test("batched map updates merge dense keys and path-copy sparse keys without losing untouched ranges", () => {
  const original = OrderedMap.from(Array.from({ length: 10_000 }, (_, i) => [i, i] as const));
  const sets = [[0, 100], [9999, 200], [20_000, 300]] as const;
  let changed = original.update(sets, [0, 5000, -1, 9999]);
  expect(changed.size).toBe(10_000);
  expect(changed.get(0)).toBe(100);
  expect(changed.get(9999)).toBe(200);
  expect(changed.has(5000)).toBe(false);
  expect(changed.get(20_000)).toBe(300);
  changed = changed.update(Array.from({ length: 1000 }, (_, i) => [i + 3000, -i] as const));
  for (let i = 0; i < 10_000; i++) {
    expect(original.get(i)).toBe(i);
    expect(changed.get(i)).toBe(i === 5000 ? undefined : i === 0 ? 100 : i === 9999 ? 200 :
      i >= 3000 && i < 4000 ? -(i - 3000) : i);
  }
});
