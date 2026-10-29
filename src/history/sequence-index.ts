import { OrderedMap } from "../collections/ordered-map.js";
import { SumTree, type SumNode, type SummaryOps } from "../collections/sum-tree.js";
import { scalarUtf8Length } from "../coordinates/text-index.js";
import { EditorError } from "../errors.js";
import type { NativeElement } from "./sequence.js";

export const ORDER_CHUNK_MAX = 64;
export interface OrderEntry {
  readonly key: string;
  /** enter/exit markers have no element; they measure zero in source dimensions. */
  readonly element: NativeElement | null;
}
export interface OrderSummary {
  readonly chunks: number;
  readonly entries: number;
  readonly full: number;
  readonly visible: number;
  readonly utf16: number;
  readonly utf8: number;
}
interface Chunk { readonly entries: readonly OrderEntry[]; readonly summary: OrderSummary }
type Node = SumNode<Chunk, OrderSummary>;
interface Parent { readonly node: Node | null; readonly before: OrderSummary }
interface ChunkLocation { readonly leaf: Extract<Node, { kind: "leaf" }>; readonly offset: number }
interface EntryLocation { readonly chunk: Chunk; readonly offset: number }

const empty: OrderSummary = Object.freeze({ chunks: 0, entries: 0, full: 0, visible: 0, utf16: 0, utf8: 0 });
function add(a: OrderSummary, b: OrderSummary): OrderSummary {
  return Object.freeze({
    chunks: a.chunks + b.chunks, entries: a.entries + b.entries, full: a.full + b.full,
    visible: a.visible + b.visible, utf16: a.utf16 + b.utf16, utf8: a.utf8 + b.utf8,
  });
}
function measure(entry: OrderEntry): OrderSummary {
  const element = entry.element;
  return Object.freeze({
    chunks: 0, entries: 1, full: element ? 1 : 0, visible: element?.visible ? 1 : 0,
    utf16: element?.visible ? element.scalar.length : 0,
    utf8: element?.visible ? scalarUtf8Length(element.scalar) : 0,
  });
}
const ops: SummaryOps<Chunk, OrderSummary> = { empty, measure: (chunk) => chunk.summary, add };
function chunks(entries: readonly OrderEntry[]): readonly Chunk[] {
  const count = Math.ceil(entries.length / ORDER_CHUNK_MAX);
  const width = Math.floor(entries.length / count);
  const remainder = entries.length % count;
  const result: Chunk[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const part = Object.freeze(entries.slice(offset, offset + width + (i < remainder ? 1 : 0)));
    const summary = part.reduce((sum, entry) => add(sum, measure(entry)), empty);
    result.push(Object.freeze({ entries: part, summary: Object.freeze({ ...summary, chunks: 1 }) }));
    offset += part.length;
  }
  return result;
}
function immutable(entry: OrderEntry): OrderEntry {
  if (entry.element) scalarUtf8Length(entry.element.scalar);
  if (Object.isFrozen(entry) && (!entry.element || Object.isFrozen(entry.element))) return entry;
  return Object.freeze({ key: entry.key, element: entry.element && Object.freeze({ ...entry.element }) });
}

// Local object locators, NOT CRDT identities/order labels. They never cross the
// history boundary. Weak keys allow retired persistent nodes/chunks to be GC'd.
const ids = new WeakMap<object, number>();
let nextId = 0;
function id(object: object): number {
  let found = ids.get(object);
  if (found === undefined) {
    if (!Number.isSafeInteger(nextId + 1)) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: local index locators");
    ids.set(object, found = ++nextId);
  }
  return found;
}

/**
 * Persistent chunked full order + visibility index. Identity -> immutable chunk
 * -> leaf -> version-local parents gives prefix ranks without relabelling IDs,
 * scanning the sequence, or writing mutable parents into shared tree nodes.
 * Parent/leaf locator maps contain ONLY live nodes of this version.
 */
export class SequenceIndex {
  readonly #tree: SumTree<Chunk, OrderSummary>;
  readonly #entries: OrderedMap<string, EntryLocation>;
  readonly #chunks: OrderedMap<number, ChunkLocation>;
  readonly #parents: OrderedMap<number, Parent>;

  private constructor(
    tree: SumTree<Chunk, OrderSummary>, entries: OrderedMap<string, EntryLocation>,
    chunkLocations: OrderedMap<number, ChunkLocation>, parents: OrderedMap<number, Parent>,
  ) {
    this.#tree = tree; this.#entries = entries; this.#chunks = chunkLocations; this.#parents = parents;
    Object.freeze(this);
  }

  static from(input: Iterable<OrderEntry>): SequenceIndex {
    const parts = chunks([...input].map(immutable));
    const tree = SumTree.from(parts, ops);
    const locations: [string, EntryLocation][] = [];
    const chunkLocations: [number, ChunkLocation][] = [];
    const parents: [number, Parent][] = [];
    const visit = (node: Node, parent: Node | null, before: OrderSummary) => {
      parents.push([id(node), Object.freeze({ node: parent, before })]);
      if (node.kind === "leaf") node.items.forEach((chunk, offset) => {
        chunkLocations.push([id(chunk), Object.freeze({ leaf: node, offset })]);
      });
      else {
        let prefix = empty;
        for (const child of node.children) { visit(child, node, prefix); prefix = add(prefix, child.summary); }
      }
    };
    if (tree.debugRoot()) visit(tree.debugRoot()!, null, empty);
    for (const chunk of parts) chunk.entries.forEach((entry, offset) => {
      locations.push([entry.key, Object.freeze({ chunk, offset })]);
    });
    const entries = OrderedMap.from(locations);
    if (entries.size !== locations.length) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: duplicate order identity");
    return new SequenceIndex(tree, entries, OrderedMap.from(chunkLocations), OrderedMap.from(parents));
  }

  get summary(): OrderSummary { return this.#tree.summary; }
  debugRoots(): Readonly<{
    order: Node | null; identities: SumNode<unknown, unknown> | null;
    chunks: SumNode<unknown, unknown> | null; parents: SumNode<unknown, unknown> | null;
  }> {
    return Object.freeze({
      order: this.#tree.debugRoot(), identities: this.#entries.debugRoot(),
      chunks: this.#chunks.debugRoot(), parents: this.#parents.debugRoot(),
    });
  }
  debugSizes(): Readonly<{ identities: number; chunks: number; parents: number }> {
    return Object.freeze({ identities: this.#entries.size, chunks: this.#chunks.size, parents: this.#parents.size });
  }

  locate(key: string): Readonly<{ entry: OrderEntry; before: OrderSummary }> | undefined {
    const location = this.#entries.get(key);
    if (!location) return undefined;
    const { chunk, offset } = location;
    const leaf = this.#chunks.get(id(chunk))!;
    let before = empty;
    for (let i = 0; i < leaf.offset; i++) before = add(before, leaf.leaf.itemSummaries[i]!);
    let node: Node = leaf.leaf;
    for (;;) {
      const parent: Parent = this.#parents.get(id(node))!;
      before = add(parent.before, before);
      if (!parent.node) break;
      node = parent.node;
    }
    for (let i = 0; i < offset; i++) before = add(before, measure(chunk.entries[i]!));
    return Object.freeze({ entry: chunk.entries[offset]!, before });
  }

  #elementAt(offset: number, dimension: "full" | "visible"): NativeElement | undefined {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.summary[dimension]) return undefined;
    const cursor = this.#tree.cursor((summary) => summary[dimension]);
    cursor.seek(offset);
    let local = offset - cursor.before[dimension];
    for (const entry of cursor.item!.entries) {
      if (entry.element && (dimension === "full" || entry.element.visible)) {
        if (!local--) return entry.element;
      }
    }
    throw new Error("SequenceIndex invariant: seek missed its element");
  }
  fullAt(offset: number): NativeElement | undefined { return this.#elementAt(offset, "full"); }
  visibleAt(offset: number): string | undefined { return this.#elementAt(offset, "visible")?.id; }
  guard(element: string): Readonly<{ before: number; visible: boolean }> | undefined {
    const found = this.locate(`${element}=`);
    return found?.entry.element && Object.freeze({ before: found.before.visible, visible: found.entry.element.visible }) || undefined;
  }
  *entries(): IterableIterator<OrderEntry> { for (const chunk of this.#tree) yield* chunk.entries; }
  *elements(): IterableIterator<NativeElement> { for (const entry of this.entries()) if (entry.element) yield entry.element; }
  *visibleRange(start: number, end: number): IterableIterator<NativeElement> {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > this.summary.visible) {
      throw new EditorError("INVALID_RANGE", "INVALID_RANGE: visible order range");
    }
    if (start === end) return;
    const cursor = this.#tree.cursor((summary) => summary.visible);
    cursor.seek(start);
    let rank = cursor.before.visible;
    while (!cursor.done) {
      for (const entry of cursor.item!.entries) if (entry.element?.visible) {
        if (rank >= end) return;
        if (rank++ >= start) yield entry.element;
      }
      cursor.next();
    }
  }

  splice(start: number, deleted: number, input: readonly OrderEntry[]): SequenceIndex {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(deleted) || start < 0 || deleted < 0 ||
      start + deleted > this.summary.entries) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: order splice");
    if (!deleted && !input.length) return this;
    const inserted = input.map(immutable);
    const seen = new Set<string>();
    for (const entry of inserted) {
      const previous = this.locate(entry.key);
      if (seen.has(entry.key) || (previous && (previous.before.entries < start || previous.before.entries >= start + deleted))) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: duplicate order identity");
      }
      seen.add(entry.key);
    }
    const first = this.#tree.cursor((summary) => summary.entries);
    const last = this.#tree.cursor((summary) => summary.entries);
    first.seek(start); last.seek(start + deleted);
    // Include one neighbour on each side, then redistribute all boundary
    // chunks. Repeated point updates cannot accumulate one-entry chunks.
    const from = Math.max(0, first.index - 1);
    const to = Math.min(this.#tree.length, last.index + 2);
    const oldChunks: Chunk[] = [];
    for (let i = from; i < to; i++) oldChunks.push(this.#tree.at(i));
    let prefix = first.before.entries;
    for (let i = from; i < first.index; i++) prefix -= this.#tree.at(i).summary.entries;
    const oldEntries = oldChunks.flatMap((chunk) => chunk.entries);
    const replacement = chunks([
      ...oldEntries.slice(0, start - prefix), ...inserted, ...oldEntries.slice(start + deleted - prefix),
    ]);
    return this.#replaceChunks(from, oldChunks, replacement);
  }

  /** Batch visibility updates by affected chunks, not by individual tree splice. */
  hide(targets: readonly string[]): SequenceIndex {
    return this.setVisibility(targets.map((id) => ({ id, visible: false })));
  }

  setVisibility(updates: readonly Readonly<{ id: string; visible: boolean }>[]): SequenceIndex {
    const affected = new Map<Chunk, Map<number, boolean>>();
    for (const update of updates) {
      const location = this.#entries.get(`${update.id}=`);
      if (!location?.chunk.entries[location.offset]?.element) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown deletion target");
      }
      const offsets = affected.get(location.chunk) ?? new Map<number, boolean>();
      if (location.chunk.entries[location.offset]!.element!.visible === update.visible) offsets.delete(location.offset);
      else offsets.set(location.offset, update.visible);
      if (offsets.size) affected.set(location.chunk, offsets);
      else affected.delete(location.chunk);
    }
    const ordered = [...affected].map(([chunk, offsets]) => ({
      chunk, offsets, index: this.locate(chunk.entries[0]!.key)!.before.chunks,
    })).sort((a, b) => b.index - a.index);
    let result: SequenceIndex = this;
    for (let i = 0; i < ordered.length;) {
      let end = i + 1;
      while (end < ordered.length && ordered[end]!.index === ordered[end - 1]!.index - 1) end++;
      const group = ordered.slice(i, end).reverse();
      const replacement = group.map(({ chunk, offsets }) => {
        const entries = Object.freeze(chunk.entries.map((entry, offset) => offsets.has(offset)
          ? Object.freeze({ ...entry, element: Object.freeze({ ...entry.element!, visible: offsets.get(offset)! }) }) : entry));
        return Object.freeze({
          entries, summary: Object.freeze({ ...entries.reduce((sum, entry) => add(sum, measure(entry)), empty), chunks: 1 }),
        });
      });
      result = result.#replaceChunks(group[0]!.index, group.map((part) => part.chunk), replacement);
      i = end;
    }
    return result;
  }

  #replaceChunks(from: number, oldChunks: readonly Chunk[], replacement: readonly Chunk[]): SequenceIndex {
    const tree = this.#tree.splice(from, oldChunks.length, replacement);
    const changed: [string, EntryLocation][] = [];
    for (const chunk of replacement) chunk.entries.forEach((entry, offset) => {
      changed.push([entry.key, Object.freeze({ chunk, offset })]);
    });
    const locations = this.#entries.update(changed, oldChunks.flatMap((chunk) => chunk.entries.map((entry) => entry.key)));

    // Discover only the new/retired fringe. A live old parent-map entry proves
    // a shared subtree; stop there rather than descending through its leaves.
    const retained = new Set<Node>();
    const fresh: Node[] = [];
    const discover = (node: Node) => {
      if (this.#parents.has(id(node))) { retained.add(node); return; }
      fresh.push(node);
      if (node.kind === "branch") for (const child of node.children) discover(child);
    };
    if (tree.debugRoot()) discover(tree.debugRoot()!);
    const retiredParents: number[] = [];
    const retiredChunks: number[] = [];
    const retire = (node: Node) => {
      if (retained.has(node)) return;
      retiredParents.push(id(node));
      if (node.kind === "leaf") for (const chunk of node.items) retiredChunks.push(id(chunk));
      else for (const child of node.children) retire(child);
    };
    if (this.#tree.debugRoot()) retire(this.#tree.debugRoot()!);
    const parentLinks: [number, Parent][] = [];
    const chunkLinks: [number, ChunkLocation][] = [];
    for (const node of fresh) {
      if (node.kind === "leaf") node.items.forEach((chunk, offset) => {
        chunkLinks.push([id(chunk), Object.freeze({ leaf: node, offset })]);
      });
      else {
        let before = empty;
        for (const child of node.children) {
          parentLinks.push([id(child), Object.freeze({ node, before })]);
          before = add(before, child.summary);
        }
      }
    }
    if (tree.debugRoot()) parentLinks.push([id(tree.debugRoot()!), Object.freeze({ node: null, before: empty })]);
    const parents = this.#parents.update(parentLinks, retiredParents);
    const chunkLocations = this.#chunks.update(chunkLinks, retiredChunks);
    return new SequenceIndex(tree, locations, chunkLocations, parents);
  }
}
