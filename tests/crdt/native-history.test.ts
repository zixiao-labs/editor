import { expect, test } from "@lightning-js/lightning";
import { actorId, documentId, externalBaseId, replicaId, type RevisionId } from "../../src/identity.js";
import { NativeHistory, type NativeTransaction } from "../../src/history/native-history.js";
import { NativeWriter } from "../../src/history/identity.js";
import { SpecReplica, type SpecTransaction } from "./support/replica.js";
import { minimizeHistory, oracleOrder } from "./support/oracle.js";
import type { PositionResolution, StablePosition } from "../../src/contracts/core.js";
import type { SourceRevision } from "../../src/model/source-revision.js";
import { SequenceIndex } from "../../src/history/sequence-index.js";

const document = documentId("native:test");
const base = externalBaseId("native:base");
const makeHistory = (text = "") => new NativeHistory({ document, base, text });
const writer = (stream: number) => new NativeWriter({
  actor: actorId(`actor:${stream}`), replica: replicaId(`replica:${stream}`),
  random: { fill(bytes) { bytes.fill(stream); } },
});
const text = (h: NativeHistory, at: RevisionId) => h.source(at).snapshot().text();
function edit(h: NativeHistory, w: NativeWriter, at: RevisionId, start: number, end: number, inserted: string) {
  const tx = h.prepare({
    at, writer: w, edits: [{ range: h.source(at).snapshot().rangeUtf16(start, end), text: inserted }],
    origin: { kind: "differential" },
  });
  if (!tx) return { at, tx };
  h.accept([tx]);
  return { at: h.revision([tx.id]), tx };
}

/**
 * Test-only representation adapter. Expand explicit native frontiers into the
 * model's full dependency sets and rename IDs; do NOT calculate ordering,
 * visibility, parent/side or insertion gaps here. The model validates those
 * independently. Only single-range edits are fed to this adapter.
 */
function specification(transactions: readonly NativeTransaction[], h: NativeHistory): {
  history: readonly SpecTransaction[]; modelId: (id: string) => string;
} {
  const names = new Map<string, string>([["^", "^"], ["$", "$"]]);
  let ordinal = 0;
  for (const _scalar of h.root.text) {
    names.set(`${h.root.id}/${ordinal.toString(16).padStart(8, "0")}`, `root/${String(ordinal).padStart(6, "0")}`);
    ordinal++;
  }
  for (const tx of transactions) {
    let insertOrdinal = 0;
    for (const effect of tx.effects) if (effect.kind === "insert") {
      names.set(effect.id, `${tx.id}/${String(insertOrdinal++).padStart(6, "0")}`);
    }
  }
  const modelId = (id: string) => {
    const name = names.get(id);
    if (!name) throw new Error(`adapter has no identity ${id}`);
    return name;
  };
  const byId = new Map(transactions.map((tx) => [tx.id, tx]));
  return {
    modelId,
    history: transactions.map((tx) => {
      const depends = new Set<string>();
      const remaining = [...tx.depends];
      while (remaining.length) {
        const id = remaining.pop()!;
        if (depends.has(id)) continue;
        depends.add(id);
        for (const dependency of byId.get(id)!.depends) remaining.push(dependency);
      }
      return {
        id: tx.id, base: h.root.text, depends: [...depends].sort(),
        inserts: tx.effects.filter((effect) => effect.kind === "insert").map((effect) => ({
          id: modelId(effect.id), value: effect.scalar, parent: modelId(effect.parent),
          side: effect.side, left: modelId(effect.left), right: modelId(effect.right), creator: tx.id,
        })),
        deletes: tx.effects.flatMap((effect) => effect.kind === "delete" ? effect.targets.map(modelId) : []),
      };
    }),
  };
}

function verifyModel(h: NativeHistory, at: RevisionId): void {
  const projected = specification(h.transactions(at), h);
  const model = new SpecReplica(h.root.text);
  model.receive(projected.history);
  const visible = h.elements(at).filter((element) => element.visible);
  expect(text(h, at)).toBe(model.text());
  expect(visible.map((element) => projected.modelId(element.id))).toEqual(model.visibleIds());
  expect(visible.map((element) => element.transaction ?? "root")).toEqual(model.snapshot().creators);
}

test("native indexed guards agree with independent model positions at every causal cut and detect discarded tombstones", () => {
  const h = makeHistory("A😀\r\n");
  const deletion = edit(h, writer(1), h.initial, 0, 1, "");
  const insertion = edit(h, writer(2), h.initial, 1, 1, "中");
  const child = edit(h, writer(3), deletion.at, 0, 0, "x");
  const hidden = edit(h, writer(4), insertion.at, 1, 2, "");
  const all = [deletion.tx!, insertion.tx!, child.tx!, hidden.tx!];
  const projected = specification(all, h);
  const cuts: { source: SourceRevision; model: SpecReplica }[] = [];
  for (let mask = 0; mask < 2 ** all.length; mask++) {
    const selected = all.filter((_, i) => mask & (1 << i));
    if (selected.some((tx) => tx.depends.some((id) => !selected.some((other) => other.id === id)))) continue;
    const model = new SpecReplica(h.root.text);
    model.receive(projected.history.filter((tx) => selected.some((other) => other.id === tx.id)));
    cuts.push({ source: h.source(h.revision(selected.map((tx) => tx.id))), model });
  }
  const numeric = (source: SourceRevision, result: PositionResolution) => {
    const offset = (position: StablePosition): number => {
      const repair = source.resolve(position);
      if (repair.status !== "present") throw new Error("repair not present");
      return repair.point.offset;
    };
    if (result.status === "present") return { status: "present", offsetUtf16: result.point.offset };
    if (result.status === "deleted") return { status: "deleted", beforeUtf16: offset(result.before), afterUtf16: offset(result.after) };
    return { status: "not-yet-created" };
  };
  const check = () => {
    const statuses = new Set<string>();
    for (const capture of cuts) {
      const snapshot = capture.source.snapshot();
      let offset = 0;
      const boundaries = [0];
      for (const scalar of snapshot.text()) boundaries.push(offset += scalar.length);
      for (const boundary of boundaries) for (const affinity of ["before", "after"] as const) {
        const position = snapshot.anchorUtf16(boundary, { affinity });
        const anchor = capture.model.anchor(boundary, affinity);
        for (const target of cuts) {
          const expected = target.model.resolve(anchor);
          const actual = numeric(target.source, target.source.resolve(position));
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`INDEXED_POSITION_MISMATCH ${JSON.stringify({ boundary, affinity, expected, actual })}`);
          }
          statuses.add(actual.status);
        }
      }
      snapshot.dispose();
    }
    return [...statuses].sort();
  };
  expect(check()).toEqual(["deleted", "not-yet-created", "present"]);
  const guard = SequenceIndex.prototype.guard;
  SequenceIndex.prototype.guard = function (id) {
    const result = guard.call(this, id);
    return result?.visible ? result : undefined;
  };
  try { expect(check).toThrow("INDEXED_POSITION_MISMATCH"); }
  finally { SequenceIndex.prototype.guard = guard; }
});

test("native right-origin order matches the independent oracle and detects ID-only and reversed-tie mutants", () => {
  const a = makeHistory();
  const b = makeHistory();
  const c = makeHistory();
  const A = edit(a, writer(1), a.initial, 0, 0, "A").tx!;
  const B = edit(b, writer(2), b.initial, 0, 0, "B").tx!;
  const C = edit(c, writer(3), c.initial, 0, 0, "C").tx!;
  a.accept([C]);
  b.accept([A]);
  const X = edit(a, writer(26), a.revision([A.id, C.id]), 1, 1, "X").tx!;
  const Y = edit(b, writer(4), b.revision([A.id, B.id]), 1, 1, "Y").tx!;
  const all = [A, B, C, X, Y];
  c.accept([...all].reverse());
  const at = c.revision(all.map((tx) => tx.id));
  expect(text(c, at)).toBe("AXYBC");
  const projected = specification(all, c);
  const oracle = oracleOrder(projected.history);
  expect(c.elements(at).map((node) => projected.modelId(node.id))).toEqual(oracle);
  for (const mutation of [{ rightOrder: "id-only" as const }, { reverseTies: true }]) {
    // A reversed-tie model would reject dependent edits authored against the
    // correct base order. Use only independent insertions for that mutation so
    // this checks an actual ordering mismatch, not an incidental validation error.
    const fixture = "reverseTies" in mutation
      ? projected.history.filter((tx) => !tx.depends.length) : projected.history;
    const mutant = new SpecReplica("", mutation);
    mutant.receive(fixture);
    expect(mutant.visibleIds()).not.toEqual(oracleOrder(fixture));
    const fails = (candidate: readonly SpecTransaction[]) => {
      const wrong = new SpecReplica("", mutation);
      wrong.receive(candidate);
      return wrong.visibleIds().join() !== oracleOrder(candidate).join();
    };
    const reduced = minimizeHistory(fixture, fails);
    expect(fails(reduced)).toBe(true);
    expect(minimizeHistory(reduced, fails)).toEqual(reduced);
    // The five-node right-origin fixture may already be 1-minimal. Reversed
    // ties require only a pair, and must actually shrink here.
    if ("reverseTies" in mutation) expect(reduced.length).toBeLessThan(all.length);
  }
  verifyModel(c, at);
});

test("native forward and backward runs stay whole across every legal delivery order and duplicate", () => {
  for (const backward of [false, true]) {
    const a = makeHistory();
    const b = makeHistory();
    const first = edit(a, writer(1), a.initial, 0, 0, backward ? "b" : "a");
    const second = edit(a, writer(3), first.at, backward ? 0 : 1, backward ? 0 : 1, backward ? "a" : "b");
    const other = edit(b, writer(2), b.initial, 0, 0, "xy");
    const history = [first.tx!, second.tx!, other.tx!];
    let schedules = 0;
    const enumerate = (done: NativeTransaction[], remaining: NativeTransaction[]) => {
      if (!remaining.length) {
        const target = makeHistory();
        for (const tx of done) {
          target.accept([tx]);
          expect(target.accept([tx])).toBe("duplicate");
        }
        const at = target.revision(done.map((tx) => tx.id));
        expect(text(target, at)).toBe("abxy");
        const projected = specification(done, target);
        expect(target.elements(at).map((node) => projected.modelId(node.id))).toEqual(oracleOrder(projected.history));
        schedules++;
      }
      for (const tx of remaining) if (tx.depends.every((id) => done.some((prior) => prior.id === id))) {
        enumerate([...done, tx], remaining.filter((other) => other !== tx));
      }
    };
    enumerate([], history);
    expect(schedules).toBe(3);
  }
});

test("native wide sibling sets keep runs whole across chunk and child-tree rebalancing", () => {
  const transactions: NativeTransaction[] = [];
  for (let i = 1; i <= 40; i++) {
    const source = makeHistory();
    transactions.push(edit(source, writer(i), source.initial, 0, 0, "x😀").tx!);
  }
  const forward = makeHistory();
  const backward = makeHistory();
  forward.accept(transactions);
  for (const transaction of [...transactions].reverse()) backward.accept([transaction]);
  const at = forward.revision(transactions.map((tx) => tx.id));
  const other = backward.revision(transactions.map((tx) => tx.id));
  expect(other).toBe(at);
  expect(text(forward, at)).toBe("x😀".repeat(40));
  expect(backward.elements(other)).toEqual(forward.elements(at));
  verifyModel(forward, at);
  verifyModel(backward, other);
});

const rawSeed = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SEED ?? "424242";
if (!/^\d+$/.test(rawSeed) || !Number.isSafeInteger(Number(rawSeed)) || Number(rawSeed) > 0xffffffff) {
  throw new Error("SEED must be a uint32 decimal integer");
}
const seed = Number(rawSeed);
function random(seed: number): (limit: number) => number {
  let state = (seed ^ 0x85ebca6b) >>> 0;
  return (limit) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
}
function shuffled<T>(values: readonly T[], next: (limit: number) => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = next(i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

test(`native three-replica offline histories agree with the model, snapshots and provenance; seed=${seed}`, () => {
  for (let run = 0; run < 16; run++) {
    const next = random((seed + run * 97) >>> 0);
    const replicas = [makeHistory("A😀\r\n"), makeHistory("A😀\r\n"), makeHistory("A😀\r\n")];
    const writers = [writer(1), writer(2), writer(3)];
    const revisions = replicas.map((h) => h.initial);
    const history: NativeTransaction[] = [];
    const old: { h: NativeHistory; at: RevisionId; text: string; snapshot: ReturnType<NativeHistory["source"]> }[] = [];
    try {
      for (let step = 0; step < 24; step++) {
        const replica = next(3);
        const h = replicas[replica]!;
        const before = text(h, revisions[replica]!);
        const offsets = [0];
        for (const scalar of before) offsets.push(offsets[offsets.length - 1]! + scalar.length);
        const low = next(offsets.length);
        const high = low + next(offsets.length - low);
        const inserted = ["x", "😀", "\u0301", "\r\n", ""][next(5)]!;
        const result = edit(h, writers[replica]!, revisions[replica]!, offsets[low]!, offsets[high]!, inserted);
        if (result.tx) history.push(result.tx);
        revisions[replica] = result.at;
        expect(text(h, result.at)).toBe(before.slice(0, offsets[low]) + inserted + before.slice(offsets[high]));
        verifyModel(h, result.at);
        old.push({ h, at: result.at, text: text(h, result.at), snapshot: h.source(result.at) });
        if (next(4) === 0) {
          const peer = next(3);
          const captured = replicas[peer]!.transactions(revisions[peer]!);
          h.accept(shuffled(captured, next));
          const imported = h.revision(captured.map((tx) => tx.id));
          revisions[replica] = h.join(result.at, imported);
        }
      }
      for (const h of replicas) {
        h.accept(shuffled(history, next));
        const at = h.revision(history.map((tx) => tx.id));
        verifyModel(h, at);
        expect(at).toBe(replicas[0]!.revision(history.map((tx) => tx.id)));
        expect(text(h, at)).toBe(text(replicas[0]!, at));
      }
      for (const saved of old) {
        expect(text(saved.h, saved.at)).toBe(saved.text);
        expect(saved.snapshot.snapshot().text()).toBe(saved.text);
      }
    } catch (cause) {
      const projected = specification(history, replicas[0]!);
      const fails = (candidate: readonly SpecTransaction[]) => {
        const ids = new Set(candidate.map((tx) => tx.id));
        try {
          const replay = makeHistory("A😀\r\n");
          replay.accept(history.filter((tx) => ids.has(tx.id)));
          verifyModel(replay, replay.revision(history.filter((tx) => ids.has(tx.id)).map((tx) => tx.id)));
          return false;
        } catch { return true; }
      };
      throw new Error(JSON.stringify({
        seed, run, history, counterexample: minimizeHistory(projected.history, fails),
      }, null, 2), { cause });
    }
  }
});

test(`native generated tiny histories match the factorial oracle at every causal cut; seed=${seed}`, () => {
  for (let run = 0; run < 12; run++) {
    const next = random((seed + run * 31) >>> 0);
    const h = makeHistory();
    const writers = [writer(1), writer(2), writer(3)];
    const at = [h.initial, h.initial, h.initial];
    const history: NativeTransaction[] = [];
    for (let step = 0; step < 6; step++) {
      const replica = next(3);
      if (next(2)) at[replica] = h.join(at[replica]!, at[next(3)]!);
      const offset = next(text(h, at[replica]!).length + 1);
      const result = edit(h, writers[replica]!, at[replica]!, offset, offset, String.fromCharCode(65 + step));
      at[replica] = result.at;
      history.push(result.tx!);
    }
    const projected = specification(history, h);
    const fails = (candidate: readonly SpecTransaction[]) => {
      const ids = new Set(candidate.map((tx) => tx.id));
      const replay = makeHistory();
      const selected = history.filter((tx) => ids.has(tx.id));
      replay.accept(selected);
      const result = replay.elements(replay.revision(selected.map((tx) => tx.id))).map((node) => projected.modelId(node.id));
      return result.join() !== oracleOrder(candidate).join();
    };
    for (let mask = 0; mask < 2 ** history.length; mask++) {
      const selected = projected.history.filter((_, i) => mask & (1 << i));
      if (selected.some((tx) => tx.depends.some((id) => !selected.some((prior) => prior.id === id)))) continue;
      if (fails(selected)) {
        throw new Error(JSON.stringify({
          seed, run, history, counterexample: minimizeHistory(selected, fails),
        }, null, 2));
      }
    }
  }
});
