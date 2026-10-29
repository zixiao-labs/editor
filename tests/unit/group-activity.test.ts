import { expect, test } from "@lightning-js/lightning";
import { NativeHistory } from "../../src/history/native-history.js";
import { NativeWriter } from "../../src/history/identity.js";
import { NativeStore } from "../../src/history/native-store.js";
import { FugueSequence } from "../../src/history/sequence.js";
import { SequenceIndex } from "../../src/history/sequence-index.js";
import { createManifest, historyBudget } from "../../src/history/transaction-group.js";
import type { SumNode } from "../../src/collections/sum-tree.js";
import { actorId, documentId, externalBaseId, replicaId, type RevisionId } from "../../src/identity.js";

const document = documentId("activity:a"), other = documentId("activity:b"), base = externalBaseId("activity:base");
const writer = (stream = 1) => new NativeWriter({
  actor: actorId("actor"), replica: replicaId("replica"), random: { fill(bytes) { bytes.fill(stream); } },
});
function edit(h: NativeHistory, w: NativeWriter, at: RevisionId, start: number, end: number, text: string) {
  const tx = h.prepare({ at, writer: w, origin: { kind: "test" },
    edits: [{ range: h.source(at).snapshot().rangeUtf16(start, end), text }] })!;
  h.accept([tx]); return { tx, at: h.revision([tx.id]) };
}
function control(h: NativeHistory, w: NativeWriter, at: RevisionId, member: ReturnType<typeof edit>, active: boolean) {
  const tx = h.prepareControl({ at, writer: w, member: member.tx.id, active })!;
  h.accept([tx]); return { tx, at: h.revision([tx.id]) };
}
const text = (h: NativeHistory, at: RevisionId) => h.text(at).toString();

test("native activity controls hide only their creators and preserve remote descendants, guards and old versions", () => {
  const h = new NativeHistory({ document, base, text: "AB" }), w = writer();
  const original = edit(h, w, h.initial, 1, 1, "xy");
  const old = h.source(original.at).snapshot();
  const position = old.anchorUtf16(1, { affinity: "after" });
  const remote = edit(h, writer(2), original.at, 2, 2, "😀");
  const undo = control(h, w, remote.at, original, false);
  expect(text(h, undo.at)).toBe("A😀B");
  expect(h.source(undo.at).resolve(position).status).toBe("deleted");
  const redo = control(h, w, undo.at, original, true);
  expect(text(h, redo.at)).toBe("Ax😀yB");
  expect(h.source(redo.at).resolve(position).status).toBe("present");
  expect(old.text()).toBe("AxyB");
  expect(h.activity(original.at, original.tx.group).active).toBe(true);
  expect(h.activity(undo.at, original.tx.group).generation).toBe(1);
  expect(h.activity(redo.at, original.tx.group).generation).toBe(2);
  expect(() => h.prepareControl({ at: redo.at, writer: w, member: undo.tx.id, active: false })).toThrow("INVALID_REFERENCE");
  expect(h.elements(redo.at).filter((node) => node.visible).map((node) => node.transaction))
    .toEqual([null, original.tx.id, remote.tx.id, original.tx.id, null]);
});

test("independent delete tags do not disappear when another deletion is undone", () => {
  const h = new NativeHistory({ document, base, text: "AB" }), a = writer(1), b = writer(2);
  const first = edit(h, a, h.initial, 0, 1, "");
  const second = edit(h, b, h.initial, 0, 1, "");
  const joined = h.join(first.at, second.at);
  const restoreOne = control(h, a, joined, first, false);
  expect(text(h, restoreOne.at)).toBe("B");
  const restoreBoth = control(h, b, restoreOne.at, second, false);
  expect(text(h, restoreBoth.at)).toBe("AB");
  const deleteAgain = control(h, a, restoreBoth.at, first, true);
  expect(text(h, deleteAgain.at)).toBe("B");
});

test("control winners use observed generation and stable IDs, not delivery or store-global latest", () => {
  const h = new NativeHistory({ document, base, text: "" }), w = writer();
  const original = edit(h, w, h.initial, 0, 0, "X");
  const undo = control(h, w, original.at, original, false);
  const concurrent = control(h, w, original.at, original, true);
  expect(undo.tx.control!.generation).toBe(1);
  expect(concurrent.tx.control!.generation).toBe(1);
  expect(text(h, h.join(undo.at, concurrent.at))).toBe("X");
  const target = new NativeHistory({ document, base, text: "" });
  target.accept([concurrent.tx, original.tx, undo.tx]);
  expect(text(target, target.revision([undo.tx.id, concurrent.tx.id]))).toBe("X");
  expect(text(target, target.revision([undo.tx.id]))).toBe("");
  expect(() => h.prepareControl({ at: original.at, writer: writer(3), member: original.tx.id, active: false })).toThrow("INVALID_REFERENCE");
  expect(() => target.accept([{ ...undo.tx, id: w.allocate(), control: { ...undo.tx.control!, generation: 4 } }])).toThrow("INVALID_REFERENCE");
});

test("multi-document controls publish one group atomically and retain meaningful no-effect history", async () => {
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(1); } } });
  const initial = [document, other].map((id) => store.createDocument({ id, base: { id: base, text: "AB" } }));
  const w = store.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = store.fork({ at: store.revisions(initial), writer: w });
  const edits = [document, other].map((document) => {
    const snapshot = head.snapshot(document);
    try { return { document, range: snapshot.rangeUtf16(0, 1), text: "x" }; } finally { snapshot.dispose(); }
  });
  const original = head.commit({ expect: head.checkpoint(), edits, origin: { kind: "test" } });
  const events: unknown[] = [];
  head.onChange((event) => events.push(event.reason));
  const restored = store.setGroupActive({ head, expect: head.checkpoint(), group: original.groups[0]!, active: false });
  expect(restored.status).toBe("applied");
  expect(restored.change.transactions.length).toBe(2);
  expect(restored.change.groups.length).toBe(1);
  for (const id of [other, document]) {
    const snapshot = head.snapshot(id);
    expect(snapshot.text()).toBe("AB"); snapshot.dispose();
  }
  const noEffect = store.setGroupActive({ head, expect: head.checkpoint(), group: original.groups[0]!, active: false });
  expect(noEffect.status).toBe("no-effect");
  expect(noEffect.change.status).toBe("committed");
  expect(noEffect.change.after.stamp).not.toBe(restored.change.after.stamp);
  await Promise.resolve();
  expect(events).toEqual(["undo", "undo"]);
  head.dispose(); w.dispose(); store.dispose();
});

test("undo reports blocked effects as partial and rejects stale/foreign domains without publishing a prefix", () => {
  let nonce = 1;
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(nonce++); } } });
  const initial = store.createDocument({ id: document, base: { id: base, text: "AB" } });
  const owner = store.openWriter({ actor: actorId("owner"), replica: replicaId("replica") });
  const remote = store.openWriter({ actor: actorId("remote"), replica: replicaId("replica") });
  const head = store.fork({ at: store.revisions([initial]), writer: owner });
  const peer = store.fork({ at: store.revisions([initial]), writer: remote });
  const commit = (head: typeof peer, text: string) => {
    const snapshot = head.snapshot(document);
    try { return head.commit({ expect: head.checkpoint(), origin: { kind: "test" },
      edits: [{ document, range: snapshot.rangeUtf16(0, 1), text }] }); } finally { snapshot.dispose(); }
  };
  const original = commit(head, "x"), deletion = commit(peer, "");
  head.merge({ expect: head.checkpoint(), source: deletion.after.revisions });
  const before = head.checkpoint();
  expect(() => store.setGroupActive({ head: peer, expect: peer.checkpoint(), group: original.groups[0]!, active: false })).toThrow("INVALID_REFERENCE");
  expect(head.checkpoint()).toBe(before);
  const undo = store.setGroupActive({ head, expect: before, group: original.groups[0]!, active: false });
  expect(undo.status).toBe("partial");
  expect(() => store.setGroupActive({ head, expect: before, group: original.groups[0]!, active: true })).toThrow("STALE_CHECKPOINT");
  const snapshot = head.snapshot(document);
  expect(snapshot.text()).toBe("B"); snapshot.dispose();
  head.dispose(); peer.dispose(); owner.dispose(); remote.dispose(); store.dispose();
});

test("typed controls with disagreeing group states reject atomically and count toward the whole-batch quota", () => {
  const sender = new NativeStore({ random: { fill(bytes) { bytes.fill(1); } } });
  const initial = [document, other].map((id) => sender.createDocument({ id, base: { id: base, text: "" } }));
  const writer = sender.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = sender.fork({ at: sender.revisions(initial), writer });
  const original = head.commit({ expect: head.checkpoint(), origin: { kind: "test" },
    edits: initial.map((entry) => {
      const snapshot = head.snapshot(entry.document);
      try { return { document: entry.document, range: snapshot.rangeUtf16(0, 0), text: "X" }; } finally { snapshot.dispose(); }
    }) });
  const undo = sender.setGroupActive({ head, expect: head.checkpoint(), group: original.groups[0]!, active: false });
  const valid = sender.exportTyped({ target: undo.change.after.revisions });
  const bundle = JSON.parse(JSON.stringify(valid)) as typeof valid;
  const controller = bundle.histories[1]!.transactions.find((tx) => tx.control)!;
  Object.assign(controller.control!, { active: true });
  const receiver = new NativeStore();
  initial.forEach((entry) => receiver.createDocument({ id: entry.document, base: { id: base, text: "" } }));
  expect(() => receiver.acceptBundle(bundle)).toThrow("INVALID_REFERENCE");
  expect(() => receiver.history.transaction(original.transactions[0]!)).toThrow("INVALID_REFERENCE");
  const manifest = valid.manifests.find((group) => group.id === undo.change.groups[0])!;
  const half = createManifest([manifest.members[0]!]);
  // A self-consistent singleton controller is still illegal for a two-doc target.
  const incomplete = {
    manifests: valid.manifests.map((group) => group === manifest ? half : group),
    histories: valid.histories.map((history, i) => ({
      ...history, transactions: history.transactions.flatMap((tx) =>
        !tx.control ? [tx] : i === 0 ? [{ ...tx, group: half.id }] : []),
    })),
    target: valid.target.map((target, i) => i === 0 ? target : {
      ...target, frontier: sender.group(original.groups[0]!).members[i]!.after,
    }),
  };
  expect(() => receiver.acceptBundle(incomplete)).toThrow("INVALID_REFERENCE");
  expect(() => receiver.history.transaction(original.transactions[0]!)).toThrow("INVALID_REFERENCE");
  const accepted = receiver.acceptBundle(valid);
  expect(accepted.status).toBe("accepted");
  expect(receiver.acceptBundle(valid).status).toBe("duplicate");
  for (const entry of accepted.availableRevisions.entries()) {
    const snapshot = receiver.snapshot(entry);
    expect(snapshot.text()).toBe(""); snapshot.dispose();
  }
  expect(receiver.history.transaction(undo.change.transactions[0]!).operations.length).toBe(1);
  expect(() => historyBudget({}, Array.from({ length: 100_001 }, () => controller))).toThrow("LIMIT_EXCEEDED");
  head.dispose(); writer.dispose(); sender.dispose(); receiver.dispose();
});

test("a small control path-copies shared order nodes without enumerating a large document", () => {
  const h = new NativeHistory({ document, base, text: "a".repeat(32_768) }), w = writer();
  const original = edit(h, w, h.initial, 16_384, 16_384, "x");
  const old = h.order(original.at);
  const nodes = (root: SumNode<unknown, unknown> | null) => {
    const result = new Set<object>(), pending = root ? [root] : [];
    while (pending.length) {
      const node = pending.pop()!; result.add(node);
      if (node.kind === "branch") for (const child of node.children) pending.push(child);
    }
    return result;
  };
  const enumerate = SequenceIndex.prototype.entries, elements = FugueSequence.prototype.elementsIterator;
  SequenceIndex.prototype.entries = () => { throw new Error("full index scan"); };
  FugueSequence.prototype.elementsIterator = () => { throw new Error("full graph replay"); };
  try {
    const undo = control(h, w, original.at, original, false);
    const before = nodes(old.debugRoots().order), after = nodes(h.order(undo.at).debugRoots().order);
    expect([...after].filter((node) => before.has(node)).length > before.size * 0.9).toBe(true);
    expect(h.order(undo.at).summary.full).toBe(old.summary.full);
    expect(h.text(undo.at).length("utf16")).toBe(32_768);
    expect(h.text(original.at).length("utf16")).toBe(32_769);
  } finally { SequenceIndex.prototype.entries = enumerate; FugueSequence.prototype.elementsIterator = elements; }
});
