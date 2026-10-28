import { SumTree, type SummaryOps } from "./sum-tree.js";

type Key = string | number;
interface Entry<K, V> { readonly key: K; readonly value: V }

/**
 * Internal persistent ordered map, using the same B+ balancing as the sequence.
 * Last-key summaries allow logarithmic lookup without a copied JS Map, hashes,
 * mutable parent pointers, fractional order labels or probabilistic balancing.
 */
export class OrderedMap<K extends Key, V> {
  readonly #tree: SumTree<Entry<K, V>, K | null>;

  private constructor(tree: SumTree<Entry<K, V>, K | null>) {
    this.#tree = tree;
    Object.freeze(this);
  }

  static from<K extends Key, V>(entries: Iterable<readonly [K, V]> = []): OrderedMap<K, V> {
    const values = [...new Map(entries)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const ops: SummaryOps<Entry<K, V>, K | null> = {
      empty: null, measure: (entry) => entry.key, add: (a, b) => b ?? a,
    };
    return new OrderedMap(SumTree.from(values.map(([key, value]) => Object.freeze({ key, value })), ops));
  }

  get size(): number { return this.#tree.length; }
  debugRoot(): ReturnType<SumTree<Entry<K, V>, K | null>["debugRoot"]> { return this.#tree.debugRoot(); }

  #find(key: K) {
    const cursor = this.#tree.cursor(() => 0);
    cursor.seekBy((last) => last !== null && last >= key);
    return cursor;
  }

  get(key: K): V | undefined {
    const entry = this.#find(key).item;
    return entry?.key === key ? entry.value : undefined;
  }

  has(key: K): boolean { return this.#find(key).item?.key === key; }

  set(key: K, value: V): OrderedMap<K, V> {
    const cursor = this.#find(key);
    if (cursor.item?.key === key && cursor.item.value === value) return this;
    const entry = Object.freeze({ key, value });
    return new OrderedMap(this.#tree.splice(cursor.index, cursor.item?.key === key ? 1 : 0, [entry]));
  }

  delete(key: K): OrderedMap<K, V> {
    const cursor = this.#find(key);
    return cursor.item?.key === key ? new OrderedMap(this.#tree.splice(cursor.index, 1, [])) : this;
  }

  /** Batch changed keys, preserving untouched ranges; sets win over removals. */
  update(sets: Iterable<readonly [K, V]>, removed: Iterable<K> = []): OrderedMap<K, V> {
    const changes = new Map<K, Entry<K, V> | null>();
    for (const key of removed) changes.set(key, null);
    for (const [key, value] of sets) changes.set(key, Object.freeze({ key, value }));
    const edits = [...changes].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const apply = (tree: SumTree<Entry<K, V>, K | null>, pending: typeof edits): SumTree<Entry<K, V>, K | null> => {
      if (!pending.length) return tree;
      const first = tree.cursor(() => 0);
      const last = tree.cursor(() => 0);
      first.seekBy((key) => key !== null && key >= pending[0]![0]);
      last.seekBy((key) => key !== null && key > pending[pending.length - 1]![0]);
      const width = last.index - first.index;
      if (width <= pending.length * 2) {
        // A dense changed range is built once. Never flatten a large unchanged
        // interval merely because two sparse keys lie on opposite sides of it.
        const values = new Map([...tree.slice(first.index, last.index)].map((entry) => [entry.key, entry]));
        for (const [key, entry] of pending) {
          if (entry) values.set(key, entry); else values.delete(key);
        }
        const sorted = [...values.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
        return tree.splice(first.index, width, sorted);
      }
      const middle = Math.floor(pending.length / 2);
      const [key, entry] = pending[middle]!;
      const cursor = tree.cursor(() => 0);
      cursor.seekBy((last) => last !== null && last >= key);
      const [before, rest] = tree.split(cursor.index);
      const after = cursor.item?.key === key ? rest.split(1)[1] : rest;
      const left = apply(before, pending.slice(0, middle));
      const right = apply(after, pending.slice(middle + 1));
      return (entry ? left.concat(tree.slice(0, 0).splice(0, 0, [entry])) : left).concat(right);
    };
    return edits.length ? new OrderedMap(apply(this.#tree, edits)) : this;
  }
}
