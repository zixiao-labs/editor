import type { ActorId, TransactionId } from "../identity.js";
import type { SourceElement } from "../model/source-revision.js";
import { scalarUtf8Length } from "../coordinates/text-index.js";
import { EditorError } from "../errors.js";
import type { RootRegistration } from "./identity.js";
import { OrderedMap } from "../collections/ordered-map.js";
import { SumTree, type SummaryOps } from "../collections/sum-tree.js";
import { TextRope } from "../text/rope.js";
import { SequenceIndex, type OrderEntry } from "./sequence-index.js";

export const START = "^";
export const END = "$";
export const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const ordinalId = (creator: string, ordinal: number): string => `${creator}/${ordinal.toString(16).padStart(8, "0")}`;

export interface NativeInsert {
  readonly kind: "insert";
  readonly id: string;
  readonly scalar: string;
  readonly parent: string;
  readonly side: "L" | "R";
  readonly left: string;
  readonly right: string;
}
export type NativeEffect = NativeInsert | Readonly<{ kind: "delete"; targets: readonly string[] }>;
export interface NativeElement extends SourceElement {
  readonly transaction: TransactionId | null;
  readonly actor: ActorId | null;
}
interface Slot {
  readonly insert: NativeInsert | null;
  readonly transaction: TransactionId | null;
  readonly actor: ActorId | null;
  readonly L: Children;
  readonly R: Children;
  readonly creator: string | null;
  readonly deletes: string | OrderedMap<string, true> | null;
  readonly activeDeletes: number;
}
type Children = string | SumTree<string, number> | null;
const childOps: SummaryOps<string, number> = { empty: 0, measure: () => 1, add: (a, b) => a + b };
const childCount = (children: Children): number => children === null ? 0 : typeof children === "string" ? 1 : children.length;
const childAt = (children: Children, index: number): string => typeof children === "string" ? children : children!.at(index);
const emptyIds = SumTree.from<string, number>([], childOps);
const noEffects = Object.freeze({ created: emptyIds, deleted: emptyIds });
const hasTag = (tags: Slot["deletes"], group: string): boolean => typeof tags === "string" ? tags === group : tags?.has(group) ?? false;
function withTag(tags: Slot["deletes"], group: string): Slot["deletes"] {
  if (!tags) return group;
  return typeof tags === "string" ? OrderedMap.from([[tags, true as const], [group, true as const]]) : tags.set(group, true);
}
function insertChild(children: Children, at: number, child: string): Children {
  if (!children) return child;
  if (typeof children === "string") return SumTree.from(at ? [children, child] : [child, children], childOps);
  return children.splice(at, 0, [child]);
}
function markers(id: string, element: NativeElement | null): readonly OrderEntry[] {
  return [
    Object.freeze({ key: `${id}<`, element: null }),
    Object.freeze({ key: `${id}=`, element }),
    Object.freeze({ key: `${id}>`, element: null }),
  ];
}

/**
 * Private staged FugueMax tree. clone() shares immutable B+ roots; writes replace
 * only affected chunks/identity paths. Zero-text enter/exit markers make subtree
 * boundaries directly addressable, including arbitrarily deep initial chains.
 * Right siblings compare CURRENT FULL-ORDER ranks, never right-origin IDs.
 */
export class FugueSequence {
  #slots: OrderedMap<string, Slot>;
  #order: SequenceIndex;
  #text: TextRope;
  #active = OrderedMap.from<string, boolean>();
  #effects = OrderedMap.from<string, Readonly<{ created: SumTree<string, number>; deleted: SumTree<string, number> }>>();

  constructor(root: RootRegistration | FugueSequence) {
    if (root instanceof FugueSequence) {
      this.#slots = root.#slots; this.#order = root.#order; this.#text = root.#text;
      this.#active = root.#active; this.#effects = root.#effects;
    } else {
      const entries: OrderEntry[] = [];
      const slots: [string, Slot][] = [];
      const scalars = [...root.text];
      const first = scalars.length ? ordinalId(root.id, 0) : null;
      slots.push([START, Object.freeze({
        insert: null, transaction: null, actor: null, L: null, R: first, creator: null, deletes: null, activeDeletes: 0,
      })]);
      entries.push(...markers(START, null).slice(0, 2));
      let previous = START;
      for (let ordinal = 0; ordinal < scalars.length; ordinal++) {
        const id = ordinalId(root.id, ordinal);
        const scalar = scalars[ordinal]!;
        const insert: NativeInsert = Object.freeze({
          kind: "insert", id, scalar, parent: previous, side: "R", left: previous, right: END,
        });
        slots.push([id, Object.freeze({
          insert, transaction: null, actor: null, L: null,
          R: ordinal + 1 < scalars.length ? ordinalId(root.id, ordinal + 1) : null,
          creator: null, deletes: null, activeDeletes: 0,
        })]);
        entries.push(...markers(id, Object.freeze({ id, scalar, visible: true, transaction: null, actor: null })).slice(0, 2));
        previous = id;
      }
      for (let ordinal = scalars.length - 1; ordinal >= 0; ordinal--) {
        entries.push(Object.freeze({ key: `${ordinalId(root.id, ordinal)}>`, element: null }));
      }
      entries.push(Object.freeze({ key: `${START}>`, element: null }));
      this.#slots = OrderedMap.from(slots);
      this.#order = SequenceIndex.from(entries);
      this.#text = TextRope.from(root.text);
    }
    Object.freeze(this);
  }

  clone(): FugueSequence { return new FugueSequence(this); }
  get order(): SequenceIndex { return this.#order; }
  get text(): TextRope { return this.#text; }
  /** Only NativeHistory's privately validated local draft may substitute its rope root. */
  reusePreparedText(text: TextRope): void { this.#text = text; }
  visible(id: string): boolean { return id === START || this.#order.guard(id)?.visible === true; }

  gap(left: string): Readonly<{ right: string; parent: string; side: "L" | "R" }> {
    const slot = this.#slots.get(left);
    if (!slot || !this.visible(left)) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: insertion left origin not visible");
    const prefix = this.#order.locate(`${left}=`)!;
    const right = this.#order.fullAt(prefix.before.full + (left === START ? 0 : 1))?.id ?? END;
    return childCount(slot.R) ? { right, parent: right, side: "L" } : { right, parent: left, side: "R" };
  }

  delete(targets: readonly string[], group = "$draft"): void {
    const added: string[] = [];
    const seen = new Set<string>();
    const slots: [string, Slot][] = [];
    for (const id of targets) {
      const slot = this.#slots.get(id);
      if (!slot?.insert) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown deletion target");
      if (hasTag(slot.deletes, group) || seen.has(id)) continue;
      seen.add(id);
      added.push(id);
      slots.push([id, Object.freeze({
        ...slot, deletes: withTag(slot.deletes, group), activeDeletes: slot.activeDeletes + (this.#active.get(group) === false ? 0 : 1),
      })]);
    }
    this.#slots = this.#slots.update(slots);
    if (added.length) {
      const effects = this.#effects.get(group) ?? noEffects;
      this.#effects = this.#effects.set(group, Object.freeze({ ...effects, deleted: effects.deleted.concat(SumTree.from(added, childOps)) }));
      this.#refresh(added);
    }
  }

  /** Toggle only this group's creation/delete tags, never recurse into descendants. */
  setGroupActive(group: string, active: boolean): void {
    if ((this.#active.get(group) ?? true) === active) return;
    const effects = this.#effects.get(group) ?? noEffects;
    this.#active = this.#active.set(group, active);
    const slots: [string, Slot][] = [];
    for (const id of effects.deleted) {
      const slot = this.#slots.get(id)!;
      slots.push([id, Object.freeze({ ...slot, activeDeletes: slot.activeDeletes + (active ? 1 : -1) })]);
    }
    this.#slots = this.#slots.update(slots);
    this.#refresh(new Set([...effects.created, ...effects.deleted]));
  }

  #refresh(affected: Iterable<string>): void {
    const updates: { id: string; visible: boolean; full: number; start: number; end: number; scalar: string }[] = [];
    for (const id of affected) {
      const slot = this.#slots.get(id)!;
      const visible = (slot.creator === null || this.#active.get(slot.creator) !== false) && slot.activeDeletes === 0;
      const old = this.#order.locate(`${id}=`)!;
      if (visible !== old.entry.element!.visible) updates.push({
        id, visible, full: old.before.full, start: old.before.visible,
        end: old.before.visible + (old.entry.element!.visible ? 1 : 0), scalar: visible ? old.entry.element!.scalar : "",
      });
    }
    updates.sort((a, b) => a.full - b.full);
    const ranges: { start: number; end: number; scalars: string[] }[] = [];
    for (const update of updates) {
      const last = ranges[ranges.length - 1];
      if (last && last.end === update.start) { last.end = update.end; last.scalars.push(update.scalar); }
      else ranges.push({ start: update.start, end: update.end, scalars: [update.scalar] });
    }
    let text = this.#text;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const range = ranges[i]!;
      text = text.replace(range.start, range.end, TextRope.fromChunks(range.scalars), "scalar");
    }
    this.#order = this.#order.setVisibility(updates);
    this.#text = text;
  }

  add(insert: NativeInsert, transaction: TransactionId | null, actor: ActorId | null): void {
    this.addRun([insert], transaction, actor);
  }

  /** A new forward chain is one chunk splice, not one persistent edit per scalar. */
  addRun(inserts: readonly NativeInsert[], transaction: TransactionId | null, actor: ActorId | null, group: string | null = null): void {
    if (!inserts.length) return;
    const insert = inserts[0]!;
    const parent = this.#slots.get(insert.parent);
    if (!parent || (insert.side !== "L" && insert.side !== "R")) {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid tree attachment");
    }
    const seen = new Set<string>();
    for (let i = 0; i < inserts.length; i++) {
      const node = inserts[i]!;
      scalarUtf8Length(node.scalar);
      if (seen.has(node.id) || this.#slots.has(node.id) ||
        (i > 0 && (node.parent !== inserts[i - 1]!.id || node.left !== node.parent || node.side !== "R" || node.right !== insert.right))) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid forward insertion chain");
      }
      seen.add(node.id);
    }
    const siblings = parent[insert.side];
    const rank = (id: string): number => {
      if (id === START) return -1;
      if (id === END) return this.#order.summary.full;
      const found = this.#order.locate(`${id}=`);
      if (found === undefined) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown right origin");
      return found.before.full;
    };
    const compare = (other: NativeInsert): number => insert.side === "R" && insert.right !== other.right
      ? rank(other.right) - rank(insert.right) : compareIds(insert.id, other.id);
    let low = 0;
    let high = childCount(siblings);
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (compare(this.#slots.get(childAt(siblings, middle))!.insert!) < 0) high = middle;
      else low = middle + 1;
    }
    const boundary = low ? `${childAt(siblings, low - 1)}>` : `${insert.parent}${insert.side === "R" ? "=" : "<"}`;
    const before = this.#order.locate(boundary)!.before;
    const position = before.visible + (low === 0 && insert.side === "R" && this.visible(insert.parent) && insert.parent !== START ? 1 : 0);
    const entries: OrderEntry[] = [];
    const slots: [string, Slot][] = [];
    inserts.forEach((node, index) => {
      const element = Object.freeze({ id: node.id, scalar: node.scalar, visible: group === null || this.#active.get(group) !== false, transaction, actor });
      entries.push(...markers(node.id, element).slice(0, 2));
      slots.push([node.id, Object.freeze({
        insert: Object.freeze({ ...node }), transaction, actor, L: null, R: inserts[index + 1]?.id ?? null,
        creator: group, deletes: null, activeDeletes: 0,
      })]);
    });
    for (let i = inserts.length - 1; i >= 0; i--) entries.push(Object.freeze({ key: `${inserts[i]!.id}>`, element: null }));
    this.#order = this.#order.splice(before.entries + 1, 0, entries);
    if (group === null || this.#active.get(group) !== false) {
      this.#text = this.#text.replace(position, position, TextRope.fromChunks(inserts.map((node) => node.scalar)), "scalar");
    }
    slots.push([insert.parent, Object.freeze({ ...parent, [insert.side]: insertChild(siblings, low, insert.id) })]);
    this.#slots = this.#slots.update(slots);
    if (group !== null) {
      const effects = this.#effects.get(group) ?? noEffects;
      this.#effects = this.#effects.set(group, Object.freeze({
        ...effects, created: effects.created.concat(SumTree.from(inserts.map((node) => node.id), childOps)),
      }));
    }
  }

  *elementsIterator(): IterableIterator<NativeElement> {
    yield* this.#order.elements();
  }

  elements(): readonly NativeElement[] { return Object.freeze([...this.elementsIterator()]); }
}
