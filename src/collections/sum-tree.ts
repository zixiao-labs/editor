import { EditorError } from "../errors.js";

export const TREE_MIN: number = 8;
export const TREE_MAX: number = 16;

/** Internal contract: items/summaries are immutable; add is associative and pure. */
export interface SummaryOps<T, S> {
  readonly empty: S;
  readonly measure: (item: T) => S;
  readonly add: (left: S, right: S) => S;
}
export interface SumLeaf<T, S> {
  readonly kind: "leaf";
  readonly height: 0;
  readonly count: number;
  readonly summary: S;
  readonly items: readonly T[];
  readonly itemSummaries: readonly S[];
}
export interface SumBranch<T, S> {
  readonly kind: "branch";
  readonly height: number;
  readonly count: number;
  readonly summary: S;
  readonly children: readonly SumNode<T, S>[];
  readonly childSummaries: readonly S[];
}
export type SumNode<T, S> = SumLeaf<T, S> | SumBranch<T, S>;
export type SeekBias = "left" | "right";

function boundary(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new EditorError("INVALID_RANGE", "INVALID_RANGE: tree offset outside its sequence");
  }
}
function sum<T, S>(summaries: readonly S[], ops: SummaryOps<T, S>): S {
  return summaries.reduce(ops.add, ops.empty);
}
function leaf<T, S>(items: readonly T[], summaries: readonly S[], ops: SummaryOps<T, S>): SumLeaf<T, S> {
  return Object.freeze({
    kind: "leaf", height: 0, count: items.length, summary: sum(summaries, ops),
    items: Object.freeze([...items]), itemSummaries: Object.freeze([...summaries]),
  });
}
function branch<T, S>(children: readonly SumNode<T, S>[], ops: SummaryOps<T, S>): SumBranch<T, S> {
  const summaries = children.map((child) => child.summary);
  return Object.freeze({
    kind: "branch", height: children[0]!.height + 1,
    count: children.reduce((count, child) => count + child.count, 0), summary: sum(summaries, ops),
    children: Object.freeze([...children]), childSummaries: Object.freeze(summaries),
  });
}
/** Redistribute the entire boundary group, not just an undersized final tail. */
function partition<T>(values: readonly T[]): readonly (readonly T[])[] {
  const groups = Math.ceil(values.length / TREE_MAX);
  const width = Math.floor(values.length / groups);
  const remainder = values.length % groups;
  const result: T[][] = [];
  let offset = 0;
  for (let i = 0; i < groups; i++) {
    const length = width + (i < remainder ? 1 : 0);
    result.push(values.slice(offset, offset + length));
    offset += length;
  }
  return result;
}

/**
 * Join returns one or two nodes at max(left.height, right.height). When attached
 * below a taller tree at least one operand is a full non-root (>= TREE_MIN),
 * so redistribution cannot leave an underfull child. Only roots may be small.
 */
function join<T, S>(left: SumNode<T, S>, right: SumNode<T, S>, ops: SummaryOps<T, S>): readonly SumNode<T, S>[] {
  if (left.height === right.height) {
    if (left.kind === "leaf" && right.kind === "leaf") {
      const items = [...left.items, ...right.items];
      const summaries = [...left.itemSummaries, ...right.itemSummaries];
      let offset = 0;
      return partition(items).map((group) => {
        const result = leaf(group, summaries.slice(offset, offset + group.length), ops);
        offset += group.length;
        return result;
      });
    }
    const children = [...(left as SumBranch<T, S>).children, ...(right as SumBranch<T, S>).children];
    return partition(children).map((group) => branch(group, ops));
  }
  if (left.height > right.height) {
    const children = (left as SumBranch<T, S>).children;
    const joined = join(children[children.length - 1]!, right, ops);
    return partition([...children.slice(0, -1), ...joined]).map((group) => branch(group, ops));
  }
  const children = (right as SumBranch<T, S>).children;
  const joined = join(left, children[0]!, ops);
  return partition([...joined, ...children.slice(1)]).map((group) => branch(group, ops));
}
function concatenate<T, S>(left: SumNode<T, S> | null, right: SumNode<T, S> | null, ops: SummaryOps<T, S>): SumNode<T, S> | null {
  if (!left) return right;
  if (!right) return left;
  const joined = join(left, right, ops);
  return joined.length === 1 ? joined[0]! : branch(joined, ops);
}
function rootOf<T, S>(children: readonly SumNode<T, S>[], ops: SummaryOps<T, S>): SumNode<T, S> | null {
  return children.length === 0 ? null : children.length === 1 ? children[0]! : branch(children, ops);
}
function split<T, S>(node: SumNode<T, S>, offset: number, ops: SummaryOps<T, S>):
  readonly [SumNode<T, S> | null, SumNode<T, S> | null] {
  if (!offset) return [null, node];
  if (offset === node.count) return [node, null];
  if (node.kind === "leaf") return [
    leaf(node.items.slice(0, offset), node.itemSummaries.slice(0, offset), ops),
    leaf(node.items.slice(offset), node.itemSummaries.slice(offset), ops),
  ];
  let local = offset;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i]!;
    if (local <= child.count) {
      const [before, after] = split(child, local, ops);
      return [
        concatenate(rootOf(node.children.slice(0, i), ops), before, ops),
        concatenate(after, rootOf(node.children.slice(i + 1), ops), ops),
      ];
    }
    local -= child.count;
  }
  throw new Error("SumTree invariant: split missed its child");
}

/**
 * Persistent measured B+ sequence. Non-root occupancy is 8..16, internal roots
 * have 2..16 children, and every leaf has equal depth. Payloads and cached item/
 * child summaries survive path copies; edits never rebuild a flat item array.
 * This is a sequence index, not an ID map, CRDT, codec or garbage collector.
 */
export class SumTree<T, S> implements Iterable<T> {
  readonly #root: SumNode<T, S> | null;
  readonly #ops: SummaryOps<T, S>;

  private constructor(root: SumNode<T, S> | null, ops: SummaryOps<T, S>) {
    this.#root = root;
    this.#ops = ops;
    Object.freeze(this);
  }

  static from<T, S>(items: Iterable<T>, ops: SummaryOps<T, S>): SumTree<T, S> {
    const values = [...items];
    if (!values.length) return new SumTree<T, S>(null, ops);
    let level: readonly SumNode<T, S>[] = partition(values).map((group) => leaf(group, group.map(ops.measure), ops));
    while (level.length > TREE_MAX) level = partition(level).map((group) => branch(group, ops));
    return new SumTree(rootOf(level, ops), ops);
  }

  get length(): number { return this.#root?.count ?? 0; }
  get summary(): S { return this.#root?.summary ?? this.#ops.empty; }
  /** Read-only structural seam for invariant/allocation tests, not a package API. */
  debugRoot(): SumNode<T, S> | null { return this.#root; }

  at(index: number): T {
    boundary(index, this.length - 1);
    let node = this.#root!;
    while (node.kind === "branch") {
      for (const child of node.children) {
        if (index < child.count) { node = child; break; }
        index -= child.count;
      }
    }
    return node.items[index]!;
  }

  split(offset: number): readonly [SumTree<T, S>, SumTree<T, S>] {
    boundary(offset, this.length);
    const [left, right] = this.#root ? split(this.#root, offset, this.#ops) : [null, null];
    return [new SumTree(left, this.#ops), new SumTree(right, this.#ops)];
  }

  concat(other: SumTree<T, S>): SumTree<T, S> {
    if (other.#ops !== this.#ops) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: incompatible summary algebra");
    if (!other.#root) return this;
    if (!this.#root) return other;
    return new SumTree(concatenate(this.#root, other.#root, this.#ops), this.#ops);
  }

  slice(start: number, end: number): SumTree<T, S> {
    boundary(start, this.length);
    boundary(end, this.length);
    if (end < start) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: reversed tree slice");
    if (!start && end === this.length) return this;
    return this.split(end)[0].split(start)[1];
  }

  splice(start: number, deleted: number, inserted: Iterable<T>): SumTree<T, S> {
    boundary(start, this.length);
    boundary(deleted, this.length - start);
    const added = SumTree.from(inserted, this.#ops);
    if (!deleted && !added.length) return this;
    const [before, remainder] = this.split(start);
    return before.concat(added).concat(remainder.split(deleted)[1]);
  }

  cursor(dimension: (summary: S) => number): SumCursor<T, S> {
    return new SumCursor(this.#root, this.#ops, dimension);
  }

  *[Symbol.iterator](): IterableIterator<T> {
    const pending = this.#root ? [this.#root] : [];
    while (pending.length) {
      const node = pending.pop()!;
      if (node.kind === "leaf") yield* node.items;
      else for (let i = node.children.length - 1; i >= 0; i--) pending.push(node.children[i]!);
    }
  }
}

/** Snapshot-bound cursor; seek one monotone numeric dimension, retain ALL fields. */
export class SumCursor<T, S> {
  readonly #root: SumNode<T, S> | null;
  readonly #ops: SummaryOps<T, S>;
  readonly #dimension: (summary: S) => number;
  #path: { node: SumBranch<T, S>; index: number }[] = [];
  #leaf: SumLeaf<T, S> | null = null;
  #item = 0;
  #index = 0;
  #before: S;

  constructor(root: SumNode<T, S> | null, ops: SummaryOps<T, S>, dimension: (summary: S) => number) {
    this.#root = root; this.#ops = ops; this.#dimension = dimension; this.#before = ops.empty;
    this.seek(0);
  }

  get item(): T | undefined { return this.#leaf?.items[this.#item]; }
  get done(): boolean { return this.#leaf === null; }
  get index(): number { return this.#index; }
  get before(): S { return this.#before; }

  seek(offset: number, bias: SeekBias = "right"): void {
    const total = this.#root?.summary ?? this.#ops.empty;
    boundary(offset, this.#dimension(total));
    if (bias !== "left" && bias !== "right") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown cursor bias");
    this.seekBy((summary) => bias === "left" ? this.#dimension(summary) >= offset : this.#dimension(summary) > offset);
  }

  /** First item whose inclusive prefix satisfies a monotone predicate (e.g. max key >= key). */
  seekBy(stops: (prefix: S) => boolean): void {
    const total = this.#root?.summary ?? this.#ops.empty;
    this.#path = []; this.#leaf = null; this.#item = 0; this.#index = 0; this.#before = this.#ops.empty;
    let node = this.#root;
    while (node?.kind === "branch") {
      let selected: SumNode<T, S> | null = null;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!;
        const end = this.#ops.add(this.#before, child.summary);
        if (stops(end)) { this.#path.push({ node, index: i }); selected = child; break; }
        this.#before = end; this.#index += child.count;
      }
      node = selected;
    }
    if (node?.kind === "leaf") {
      for (let i = 0; i < node.items.length; i++) {
        const end = this.#ops.add(this.#before, node.itemSummaries[i]!);
        if (stops(end)) { this.#leaf = node; this.#item = i; return; }
        this.#before = end; this.#index++;
      }
    }
    this.#before = total; this.#index = this.#root?.count ?? 0; this.#path = [];
  }

  next(): void {
    if (!this.#leaf) return;
    this.#before = this.#ops.add(this.#before, this.#leaf.itemSummaries[this.#item]!);
    this.#index++;
    if (++this.#item < this.#leaf.items.length) return;
    while (this.#path.length) {
      const frame = this.#path[this.#path.length - 1]!;
      if (++frame.index < frame.node.children.length) {
        let node = frame.node.children[frame.index]!;
        while (node.kind === "branch") {
          this.#path.push({ node, index: 0 });
          node = node.children[0]!;
        }
        this.#leaf = node; this.#item = 0;
        return;
      }
      this.#path.pop();
    }
    this.#leaf = null; this.#item = 0;
  }
}
