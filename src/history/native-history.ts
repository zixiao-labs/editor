import type { EditOrigin, TextRange } from "../contracts/core.js";
import { TextIndex, scalarUtf8Length } from "../coordinates/text-index.js";
import { EditorError, type JsonValue } from "../errors.js";
import {
  actorId, replicaId, revisionId, type ActorId, type ReplicaId, type RevisionId, type TransactionId, type TransactionGroupId,
} from "../identity.js";
import { SourceRevision } from "../model/source-revision.js";
import { TextRope } from "../text/rope.js";
import type { SequenceIndex } from "./sequence-index.js";
import { canonicalCopy, canonicalJson, framedDigest } from "./canonical.js";
import { checkTransactionId, createRoot, NativeWriter, type RootRegistration } from "./identity.js";
import {
  compareIds, FugueSequence, ordinalId, START, type NativeEffect, type NativeElement, type NativeInsert,
} from "./sequence.js";
import { checkGroupId, createManifest, MAX_HISTORY_BYTES, MAX_HISTORY_OPERATIONS } from "./transaction-group.js";

/** Internal typed single-document effects, NOT a versioned/untrusted wire codec. */
export interface NativeTransaction {
  readonly id: TransactionId;
  readonly group: TransactionGroupId;
  readonly root: string;
  readonly depends: readonly TransactionId[];
  readonly actor: ActorId;
  readonly replica: ReplicaId;
  readonly origin: EditOrigin;
  readonly attribution?: JsonValue;
  readonly effects: readonly NativeEffect[];
}
interface NativeRevision {
  readonly frontier: readonly TransactionId[];
  readonly ordered: readonly NativeTransaction[];
}
interface Materialization {
  readonly ordered: readonly NativeTransaction[];
  /** Never mutated after storage; every staged writer first clones its roots. */
  readonly sequence: FugueSequence;
}
export interface NativeEdit { readonly range: TextRange; readonly text: string }
export interface NativeDraft { readonly transaction: NativeTransaction }

function invalid(message: string): never {
  throw new EditorError("INVALID_REFERENCE", `INVALID_REFERENCE: ${message}`);
}
/** Only uninterrupted newly created forward chains can share one index splice. */
function forwardRun(effects: readonly NativeEffect[], start: number): readonly NativeInsert[] {
  const first = effects[start] as NativeInsert;
  const run = [first];
  for (let i = start + 1; i < effects.length; i++) {
    const next = effects[i]!;
    if (next.kind !== "insert" || next.parent !== run[run.length - 1]!.id || next.left !== next.parent ||
      next.side !== "R" || next.right !== first.right) break;
    run.push(next);
  }
  return run;
}
export function transactionMetadata(input: Pick<NativeTransaction, "actor" | "replica" | "origin" | "attribution">):
  Pick<NativeTransaction, "actor" | "replica" | "origin" | "attribution"> {
  const copy = canonicalCopy({
    actor: input.actor, replica: input.replica, origin: input.origin,
    ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
  }, 16 * 1024);
  actorId(copy.actor);
  replicaId(copy.replica);
  if (!copy.origin || typeof copy.origin.kind !== "string" || !copy.origin.kind.length ||
    (copy.origin.label !== undefined && typeof copy.origin.label !== "string")) invalid("invalid edit origin");
  return copy;
}

/** Kahn ordering, with fixed stream/counter ties. No recursive graph walk. */
function topological(transactions: ReadonlyMap<TransactionId, NativeTransaction>): readonly NativeTransaction[] {
  const counts = new Map<TransactionId, number>();
  const children = new Map<TransactionId, TransactionId[]>();
  const ready: TransactionId[] = [];
  let missing = false;
  for (const tx of transactions.values()) {
    let count = 0;
    for (const dependency of tx.depends) {
      if (!transactions.has(dependency)) { missing = true; continue; }
      count++;
      const siblings = children.get(dependency) ?? [];
      siblings.push(tx.id);
      children.set(dependency, siblings);
    }
    counts.set(tx.id, count);
    if (!count) ready.push(tx.id);
  }
  ready.sort(compareIds);
  const ordered: NativeTransaction[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    ordered.push(transactions.get(id)!);
    for (const child of children.get(id) ?? []) {
      const count = counts.get(child)! - 1;
      counts.set(child, count);
      if (!count) {
        let low = 0;
        let high = ready.length;
        while (low < high) {
          const middle = low + Math.floor((high - low) / 2);
          if (compareIds(child, ready[middle]!) < 0) high = middle;
          else low = middle + 1;
        }
        ready.splice(low, 0, child);
      }
    }
  }
  if (ordered.length !== transactions.size) {
    throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: transaction dependency cycle");
  }
  if (missing) throw new EditorError("MISSING_DEPENDENCIES", "MISSING_DEPENDENCIES: incomplete transaction closure");
  return ordered;
}

/**
 * Append-only, single-document history kernel. Owns validated causal closures,
 * NOT heads, CAS, pending import queues, undo registers or atomic group manifests.
 * No public factory delegates to this until those layers and the codec exist.
 */
export class NativeHistory {
  readonly root: RootRegistration;
  readonly initial: RevisionId;
  readonly #accepted = new Map<TransactionId, NativeTransaction>();
  readonly #revisions = new Map<RevisionId, NativeRevision>();
  #states = new Map<RevisionId, Materialization>();
  readonly #sources = new Map<RevisionId, WeakRef<SourceRevision>>();
  readonly #prepared = new WeakMap<NativeTransaction, TextRope>();
  readonly #drafts = new WeakMap<NativeDraft, TextRope>();

  constructor(input: Omit<RootRegistration, "id"> | NativeHistory) {
    if (input instanceof NativeHistory) {
      this.root = input.root;
      this.initial = input.initial;
      for (const [id, tx] of input.#accepted) this.#accepted.set(id, tx);
      for (const [id, revision] of input.#revisions) this.#revisions.set(id, revision);
      for (const [id, state] of input.#states) this.#states.set(id, state);
      for (const [id, source] of input.#sources) this.#sources.set(id, source);
    } else {
      this.root = createRoot(input);
      this.initial = this.#record([]);
      this.#states.set(this.initial, Object.freeze({ ordered: Object.freeze([]), sequence: new FugueSequence(this.root) }));
    }
    Object.freeze(this);
  }

  #closure(frontier: readonly TransactionId[], available = this.#accepted): readonly NativeTransaction[] {
    const selected = new Map<TransactionId, NativeTransaction>();
    const pending = [...frontier];
    while (pending.length) {
      const id = pending.pop()!;
      if (selected.has(id)) continue;
      const tx = available.get(id);
      if (!tx) throw new EditorError("UNKNOWN_REVISION", "UNKNOWN_REVISION: unknown frontier transaction");
      selected.set(id, tx);
      for (const dependency of tx.depends) pending.push(dependency);
    }
    return topological(selected);
  }

  #frontier(ordered: readonly NativeTransaction[]): readonly TransactionId[] {
    const maximal = new Set(ordered.map((tx) => tx.id));
    for (const tx of ordered) for (const dependency of tx.depends) maximal.delete(dependency);
    return Object.freeze([...maximal].sort(compareIds));
  }

  #key(frontier: readonly TransactionId[]): RevisionId {
    return revisionId(`rev:${framedDigest("editor/revision/v1", [this.root.id, ...frontier])}`);
  }

  #record(ordered: readonly NativeTransaction[]): RevisionId {
    const frontier = this.#frontier(ordered);
    const id = this.#key(frontier);
    if (!this.#revisions.has(id)) {
      this.#revisions.set(id, Object.freeze({ frontier, ordered: Object.freeze([...ordered]) }));
    }
    return id;
  }

  #known(at: RevisionId): NativeRevision {
    const revision = this.#revisions.get(at);
    if (!revision) throw new EditorError("UNKNOWN_REVISION", "UNKNOWN_REVISION: revision was not registered in this history");
    return revision;
  }

  revision(frontier: readonly TransactionId[]): RevisionId { return this.#record(this.#closure(frontier)); }

  join(left: RevisionId, right: RevisionId): RevisionId {
    return this.revision([...this.#known(left).frontier, ...this.#known(right).frontier]);
  }

  transaction(id: TransactionId): NativeTransaction {
    return this.#accepted.get(id) ?? invalid("unknown transaction");
  }

  transactions(at: RevisionId): readonly NativeTransaction[] { return this.#known(at).ordered; }
  closure(frontier: readonly TransactionId[]): readonly NativeTransaction[] { return Object.freeze([...this.#closure(frontier)]); }
  frontier(at: RevisionId): readonly TransactionId[] { return this.#known(at).frontier; }
  hasTransaction(id: TransactionId): boolean { return this.#accepted.has(id); }

  /** Private staging owner: immutable transactions/revisions may be shared. */
  clone(): NativeHistory { return new NativeHistory(this); }

  #apply(sequence: FugueSequence, tx: NativeTransaction): void {
    for (let i = 0; i < tx.effects.length; i++) {
      const effect = tx.effects[i]!;
      if (effect.kind === "delete") sequence.delete(effect.targets);
      else {
        const run = forwardRun(tx.effects, i);
        sequence.addRun(run, tx.id, tx.actor);
        i += run.length - 1;
      }
    }
  }

  #materialize(ordered: readonly NativeTransaction[], states = this.#states): Materialization {
    const frontier = this.#frontier(ordered);
    const key = this.#key(frontier);
    const exact = states.get(key);
    if (exact) return exact;
    // A frontier member's validated closure is necessarily a causal subset,
    // unlike a coincidentally similar writer counter or text. Reuse the largest
    // such materialization and apply ONLY missing effects in causal order.
    let base = states.get(this.initial)!;
    for (const id of frontier) {
      const candidate = states.get(this.#key([id]));
      if (candidate && candidate.ordered.length > base.ordered.length) base = candidate;
    }
    const included = new Set(base.ordered.map((tx) => tx.id));
    const sequence = base.sequence.clone();
    for (const tx of ordered) if (!included.has(tx.id)) this.#apply(sequence, tx);
    const state = Object.freeze({ ordered, sequence });
    states.set(key, state);
    return state;
  }

  elements(at: RevisionId): readonly NativeElement[] { return this.#materialize(this.#known(at).ordered).sequence.elements(); }

  order(at: RevisionId): SequenceIndex { return this.#materialize(this.#known(at).ordered).sequence.order; }

  text(at: RevisionId): TextRope { return this.#materialize(this.#known(at).ordered).sequence.text; }

  source(at: RevisionId): SourceRevision {
    const cached = this.#sources.get(at)?.deref();
    if (cached) return cached;
    const sequence = this.#materialize(this.#known(at).ordered).sequence;
    const source = new SourceRevision({
      document: this.root.document, root: this.root.id, revision: at,
      order: sequence.order, text: sequence.text,
    });
    this.#sources.set(at, new WeakRef(source));
    return source;
  }

  prepare(input: {
    at: RevisionId; writer: NativeWriter; edits: readonly NativeEdit[]; origin: EditOrigin; attribution?: JsonValue;
  }): NativeTransaction | null {
    const draft = this.draft(input);
    if (!draft) return null;
    const allocation = input.writer.plan(1);
    const transaction = this.finalize(draft, allocation.ids[0]!);
    input.writer.commit(allocation);
    return transaction;
  }

  /** Validate/edit first, with no writer counter allocation. Owner-bound, immutable draft. */
  draft(input: {
    at: RevisionId; writer: NativeWriter; edits: readonly NativeEdit[]; origin: EditOrigin; attribution?: JsonValue;
  }): NativeDraft | null {
    input.writer.assertActive();
    const revision = this.#known(input.at);
    const meta = transactionMetadata({
      actor: input.writer.actor, replica: input.writer.replica, origin: input.origin,
      ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    });
    const base = this.#materialize(revision.ordered).sequence;
    const sequence = base.clone();
    const original = base.text;
    const index = new TextIndex(original);
    const edits = input.edits.map(({ range, text }) => {
      if (range.document !== this.root.document || range.revision !== input.at) {
        throw new EditorError("WRONG_REVISION", "WRONG_REVISION: every range must belong to the declared base");
      }
      const start = index.scalarAt(range.start, range.unit);
      const end = index.scalarAt(range.end, range.unit);
      if (end < start) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: reversed edit");
      // Validate before allocating IDs or applying anything.
      const inserted = TextRope.from(text);
      return { start, end, text, inserted, count: inserted.summary.scalars };
    }).sort((a, b) => a.start - b.start || a.end - b.end);
    const normalized: typeof edits = [];
    for (const edit of edits) {
      const previous = normalized[normalized.length - 1];
      if (previous) {
        if (previous.start === edit.start && previous.end === edit.end) {
          if (previous.text !== edit.text) throw new EditorError("ALIAS_EDIT_CONFLICT", "ALIAS_EDIT_CONFLICT: identical ranges differ");
          continue;
        }
        if (edit.start < previous.end ||
          (edit.start === previous.end && (previous.start === previous.end || edit.start === edit.end))) {
          throw new EditorError("OVERLAPPING_EDITS", "OVERLAPPING_EDITS: ranges or caret endpoints conflict");
        }
      }
      normalized.push(edit);
    }
    // Validate aliases/overlaps BEFORE removing no-ops. An unchanged edit cannot
    // hide a conflicting overlapping range merely by appearing first.
    const changes = normalized.filter((edit) => !original.slice(edit.start, edit.end, "scalar").equals(edit.inserted));
    let expected = original;
    for (let i = changes.length - 1; i >= 0; i--) {
      const edit = changes[i]!;
      expected = expected.replace(edit.start, edit.end, edit.inserted, "scalar");
    }
    // Individually different adjacent replacements can cancel out in the net
    // source text. They are no-change too, not a reason to manufacture history.
    if (expected.equals(original)) return null;
    const count = changes.reduce((sum, edit) => sum + edit.count + edit.end - edit.start, 0);
    if (count > MAX_HISTORY_OPERATIONS) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: transaction operations");
    // All identities have the same encoded width. Generate with a private
    // placeholder and check the full typed representation BEFORE consuming a
    // writer counter, so local validation failures leave it untouched.
    // The reserved d: namespace cannot collide with ANY accepted t: stream,
    // including deterministic/random all-zero nonces.
    const placeholder = "d:00000000000000000000000000000000:0000000000000001" as TransactionId;
    const effects: NativeEffect[] = [];
    for (let i = changes.length - 1; i >= 0; i--) {
      const edit = changes[i]!;
      const targets = [...base.order.visibleRange(edit.start, edit.end)].map((node) => node.id);
      if (targets.length) {
        effects.push({ kind: "delete", targets });
        sequence.delete(targets);
      }
      let left = base.order.visibleAt(edit.start - 1) ?? START;
      const run: NativeInsert[] = [];
      const gap = sequence.gap(left);
      for (const scalar of edit.text) {
        const insert: NativeInsert = {
          kind: "insert", id: ordinalId(placeholder, effects.length), scalar, left,
          ...(run.length ? { right: gap.right, parent: left, side: "R" as const } : gap),
        };
        effects.push(insert);
        run.push(insert);
        left = insert.id;
      }
      sequence.addRun(run, placeholder, meta.actor);
    }
    if (!sequence.text.equals(expected)) invalid("generated effects do not match simultaneous replacement");
    const draft: NativeTransaction = {
      id: placeholder, group: `group:${"0".repeat(64)}` as TransactionGroupId,
      root: this.root.id, depends: revision.frontier, ...meta, effects,
    };
    const result = Object.freeze({ transaction: canonicalCopy([draft], MAX_HISTORY_BYTES)[0]! });
    this.#drafts.set(result, expected);
    return result;
  }

  finalize(input: NativeDraft, id: TransactionId, group?: TransactionGroupId): NativeTransaction {
    const expected = this.#drafts.get(input);
    if (!expected) invalid("draft belongs to another staging history");
    checkTransactionId(id);
    const draft = input.transaction;
    const placeholder = draft.id;
    const effects = draft.effects;
    const membership = group ?? createManifest([{
      document: this.root.document, base: this.root.base, root: this.root.id,
      transaction: id, before: draft.depends, after: [id],
    }]).id;
    checkGroupId(membership);
    // Rewrite only identities generated by THIS draft, never origin strings,
    // metadata or an external node with a similar prefix.
    const generated = new Set(effects.filter((effect) => effect.kind === "insert").map((effect) => effect.id));
    const rekey = (reference: string): string => generated.has(reference) ? id + reference.slice(placeholder.length) : reference;
    const transaction = canonicalCopy({
      ...draft, id, group: membership, effects: effects.map((effect) => effect.kind === "delete" ? effect : {
        ...effect, id: rekey(effect.id), parent: rekey(effect.parent), left: rekey(effect.left), right: rekey(effect.right),
      }),
    });
    this.#prepared.set(transaction, expected);
    return transaction;
  }

  #validate(tx: NativeTransaction, available: Map<TransactionId, NativeTransaction>, states: Map<RevisionId, Materialization>): void {
    const dependencies = this.#closure(tx.depends, available);
    if (canonicalJson(tx.depends) !== canonicalJson(this.#frontier(dependencies))) {
      throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: dependencies must be a canonical frontier");
    }
    const base = this.#materialize(dependencies, states).sequence;
    const sequence = base.clone();
    const deleted = new Set<string>();
    for (let ordinal = 0; ordinal < tx.effects.length; ordinal++) {
      const effect = tx.effects[ordinal]!;
      if (effect.kind === "delete") {
        if (!Array.isArray(effect.targets) || !effect.targets.length) invalid("empty or malformed deletion");
        for (const id of effect.targets) {
          if (id === START || !base.visible(id) || deleted.has(id)) invalid("delete must name distinct base-visible elements");
          deleted.add(id);
        }
        sequence.delete(effect.targets);
      } else if (effect.kind === "insert") {
        const gap = sequence.gap(effect.left);
        if (effect.parent !== gap.parent || effect.side !== gap.side || effect.right !== gap.right) {
          invalid("insertion does not match declared causal gap");
        }
        const run = forwardRun(tx.effects, ordinal);
        for (let i = 0; i < run.length; i++) {
          scalarUtf8Length(run[i]!.scalar);
          if (run[i]!.id !== ordinalId(tx.id, ordinal + i)) invalid("insertion identity does not match effect ordinal");
        }
        sequence.addRun(run, tx.id, tx.actor);
        ordinal += run.length - 1;
      } else invalid("unknown effect kind");
    }
    states.set(this.#key([tx.id]), Object.freeze({ ordered: Object.freeze([...dependencies, tx]), sequence }));
  }

  /** Typed staging seam only: no defer queue, envelope decoder or group acceptance. */
  accept(incoming: readonly NativeTransaction[]): "accepted" | "duplicate" {
    const staged = new Map(this.#accepted);
    const states = new Map(this.#states);
    const added = new Set<TransactionId>();
    // Detach all caller aliases and validate identity/envelope budgets first.
    const copied = canonicalCopy(incoming, MAX_HISTORY_BYTES);
    let operations = 0;
    for (const tx of copied) {
      checkTransactionId(tx.id);
      checkGroupId(tx.group);
      if (tx.root !== this.root.id) throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: transaction belongs to another root");
      transactionMetadata(tx);
      if (!Array.isArray(tx.depends) || !Array.isArray(tx.effects)) invalid("malformed transaction arrays");
      for (const dependency of tx.depends) checkTransactionId(dependency);
      if (new Set(tx.depends).size !== tx.depends.length) {
        throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: duplicate dependency");
      }
      for (const effect of tx.effects) operations += effect.kind === "delete" ? effect.targets.length : 1;
      if (operations > MAX_HISTORY_OPERATIONS) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: transaction operations");
      const previous = staged.get(tx.id);
      if (previous && canonicalJson(previous) !== canonicalJson(tx)) {
        throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: same transaction identity has different effects or metadata");
      }
      if (!previous) { staged.set(tx.id, tx); added.add(tx.id); }
    }
    const ordered = topological(staged);
    for (const tx of ordered) if (added.has(tx.id)) this.#validate(tx, staged, states);
    // Nothing above publishes even a valid prefix. Revisions are explicit
    // queries; accepting history does not introduce an implicit latest head.
    for (const id of added) this.#accepted.set(id, staged.get(id)!);
    this.#states = states;
    // Only privately registered local prepare results can transfer persistent
    // text roots. Detached typed imports materialize from validated effects.
    for (const transaction of incoming) {
      const text = this.#prepared.get(transaction);
      if (text) {
        const at = this.#record(this.#closure([transaction.id]));
        const state = this.#states.get(at)!;
        const sequence = state.sequence.clone();
        sequence.reusePreparedText(text);
        this.#states.set(at, Object.freeze({ ordered: state.ordered, sequence }));
      }
    }
    return added.size ? "accepted" : "duplicate";
  }
}
