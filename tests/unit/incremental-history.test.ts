import { expect, test } from "@lightning-js/lightning";
import { NativeHistory, type NativeTransaction } from "../../src/history/native-history.js";
import { NativeStore } from "../../src/history/native-store.js";
import { NativeWriter } from "../../src/history/identity.js";
import { FugueSequence, type NativeInsert } from "../../src/history/sequence.js";
import { SequenceIndex } from "../../src/history/sequence-index.js";
import { actorId, documentId, externalBaseId, replicaId, type RevisionId } from "../../src/identity.js";
import type { SumNode } from "../../src/collections/sum-tree.js";

const document = documentId("incremental");
const base = externalBaseId("base");
const writer = (stream = 1) => new NativeWriter({
  actor: actorId("actor"), replica: replicaId("replica"), random: { fill(bytes) { bytes.fill(stream); } },
});
function edit(h: NativeHistory, w: NativeWriter, at: RevisionId, start: number, end: number, text: string) {
  const tx = h.prepare({
    at, writer: w, origin: { kind: "incremental" },
    edits: [{ range: h.source(at).snapshot().rangeUtf16(start, end), text }],
  })!;
  h.accept([tx]);
  return { tx, at: h.revision([tx.id]) };
}
function nodes(root: SumNode<unknown, unknown> | null): Set<object> {
  const result = new Set<object>();
  const visit = (node: SumNode<unknown, unknown>) => {
    result.add(node);
    if (node.kind === "branch") for (const child of node.children) visit(child);
  };
  if (root) visit(root);
  return result;
}

test("accepted revisions path-copy both CRDT order and identity indexes, retaining old branches", () => {
  const h = new NativeHistory({ document, base, text: "a".repeat(32_768) });
  const original = h.order(h.initial);
  const staged = h.clone();
  expect(staged.order(h.initial)).toBe(original);
  const changed = edit(staged, writer(), h.initial, 16_384, 16_385, "😀");
  const before = original.debugRoots();
  const after = staged.order(changed.at).debugRoots();
  for (const key of ["order", "identities"] as const) {
    const oldNodes = nodes(before[key]);
    const newNodes = nodes(after[key]);
    const shared = [...newNodes].filter((node) => oldNodes.has(node)).length;
    expect(shared > oldNodes.size * 0.90).toBe(true);
    expect(newNodes.size - shared < 150).toBe(true);
  }
  expect(h.order(h.initial)).toBe(original);
  expect(original.summary.visible).toBe(32_768);
  expect(original.summary.full).toBe(32_768);
  expect(staged.order(changed.at).summary.full).toBe(32_769);
  expect(staged.order(changed.at).summary.utf16).toBe(32_769);
  expect(staged.source(changed.at).snapshot().text().slice(16_383, 16_387)).toBe("a😀a");
});

test("cold merge applies only missing causal effects and memoized/old revisions apply none", () => {
  const h = new NativeHistory({ document, base, text: "R" });
  const common = edit(h, writer(1), h.initial, 1, 1, "c");
  const left = edit(h, writer(2), common.at, 2, 2, "L");
  const right = edit(h, writer(3), common.at, 2, 2, "Q");
  const all = [common.tx, left.tx, right.tx];
  const imported = new NativeHistory({ document, base, text: "R" });
  const addRun = FugueSequence.prototype.addRun;
  const calls: string[] = [];
  FugueSequence.prototype.addRun = function (inserts, transaction, actor, group) {
    calls.push(...inserts.map((insert) => insert.id));
    return addRun.call(this, inserts, transaction, actor, group);
  };
  try {
    imported.accept(JSON.parse(JSON.stringify([...all].reverse())) as NativeTransaction[]);
    expect(calls).toEqual(all.flatMap((tx) => tx.effects.flatMap((effect) => effect.kind === "insert" ? [effect.id] : [])));
    calls.length = 0;
    const joined = imported.join(imported.revision([left.tx.id]), imported.revision([right.tx.id]));
    expect(imported.text(joined).toString()).toBe("RcLQ");
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toBe(common.tx.effects[0]!.kind === "insert" && common.tx.effects[0]!.id);
    calls.length = 0;
    imported.source(joined).snapshot().anchorUtf16(2, { affinity: "before" });
    imported.text(joined);
    imported.source(imported.revision([common.tx.id])).snapshot().text();
    expect(calls).toEqual([]);
    expect(h.source(h.join(left.at, right.at)).snapshot().text()).toBe("RcLQ");
  } finally { FugueSequence.prototype.addRun = addRun; }
});

test("real head edits and position queries neither enumerate full order nor replay prior effects", () => {
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(1); } } });
  const initial = store.createDocument({ id: document, base: { id: base, text: "a".repeat(8192) } });
  const w = store.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = store.fork({ at: store.revisions([initial]), writer: w });
  for (let i = 0; i < 20; i++) {
    const snapshot = head.snapshot(document);
    head.commit({
      expect: head.checkpoint(), origin: { kind: "prefix" },
      edits: [{ document, range: snapshot.rangeUtf16(i, i + 1), text: "b" }],
    });
    snapshot.dispose();
  }
  const old = head.snapshot(document);
  const guard = old.anchorUtf16(4096, { affinity: "after" });
  const addRun = FugueSequence.prototype.addRun;
  const entries = SequenceIndex.prototype.entries;
  const elements = FugueSequence.prototype.elementsIterator;
  const splice = SequenceIndex.prototype.splice;
  let inserted = 0;
  let splices = 0;
  FugueSequence.prototype.addRun = function (run: readonly NativeInsert[], transaction, actor, group) {
    inserted += run.length; return addRun.call(this, run, transaction, actor, group);
  };
  SequenceIndex.prototype.entries = () => { throw new Error("full order enumeration"); };
  FugueSequence.prototype.elementsIterator = () => { throw new Error("full graph projection"); };
  SequenceIndex.prototype.splice = function (...args: Parameters<SequenceIndex["splice"]>): SequenceIndex {
    splices++; return splice.apply(this, args);
  };
  try {
    head.commit({
      expect: head.checkpoint(), origin: { kind: "no-replay" },
      edits: [{ document, range: old.rangeUtf16(4096, 4097), text: "😀".repeat(1000) }],
    });
    const current = head.snapshot(document);
    expect(current.lengthUtf16).toBe(10_191);
    expect(current.convertPoint(current.pointScalar(5096), "utf16").offset).toBe(6096);
    const at = { document, revision: current.revision };
    const resolved = store.history.resolve({ at, position: guard });
    expect(resolved.status).toBe("deleted");
    if (resolved.status === "deleted") expect(store.history.resolve({ at, position: resolved.after }).status).toBe("present");
    expect(inserted).toBe(2000); // one prepare + one validation run, no old effects
    expect(splices).toBe(2); // one splice per 1000-scalar run, not per scalar
    expect(old.lengthUtf16).toBe(8192);
    current.dispose();
  } finally {
    FugueSequence.prototype.addRun = addRun; SequenceIndex.prototype.entries = entries;
    FugueSequence.prototype.elementsIterator = elements; SequenceIndex.prototype.splice = splice;
    old.dispose(); head.dispose(); w.dispose(); store.dispose();
  }
});
