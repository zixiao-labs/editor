import { expect, test } from "@lightning-js/lightning";
import { actorId, documentId, externalBaseId, replicaId, revisionId } from "../../src/identity.js";
import { NativeHistory, type NativeTransaction } from "../../src/history/native-history.js";
import { NativeWriter } from "../../src/history/identity.js";
import type { JsonValue } from "../../src/errors.js";

const document = documentId("test:doc");
const base = externalBaseId("test:base");
const history = (text = "") => new NativeHistory({ document, base, text });
const writer = (byte = 1) => new NativeWriter({
  actor: actorId(`actor:${byte}`), replica: replicaId("replica"),
  random: { fill(bytes) { bytes.fill(byte); } },
});
function edit(h: NativeHistory, w: NativeWriter, at = h.initial, start = 0, end = start, text = "X") {
  const tx = h.prepare({
    at, writer: w, edits: [{ range: h.source(at).snapshot().rangeUtf16(start, end), text }],
    origin: { kind: "test" },
  })!;
  h.accept([tx]);
  return { tx, at: h.revision([tx.id]) };
}

test("root and causal revisions are canonical, not text hashes or stream prefixes", () => {
  const h = history("A😀\r\n");
  expect(h.initial).toBe(revisionId("rev:0355925a816cfa10162b94b0789da645554ab36cbcac9a2bb5cbcf9e21766724"));
  const w = writer();
  const first = edit(h, w, h.initial, 0, 1, "B");
  const isolated = edit(h, w, h.initial, 0, 1, "B");
  expect(first.tx.depends).toEqual([]);
  expect(isolated.tx.depends).toEqual([]);
  expect(first.at).not.toBe(isolated.at);
  expect(h.source(first.at).snapshot().text()).toBe(h.source(isolated.at).snapshot().text());
  const restored = edit(h, w, first.at, 0, 1, "A");
  expect(h.source(restored.at).snapshot().text()).toBe(h.source(h.initial).snapshot().text());
  expect(restored.at).not.toBe(h.initial);
  const child = edit(h, w, first.at, 0, 0, "B");
  expect(child.tx.depends).toEqual([first.tx.id]);
  expect(h.revision([child.tx.id, first.tx.id, child.tx.id])).toBe(child.at);
  expect(h.join(first.at, isolated.at)).toBe(h.join(isolated.at, first.at));
  expect(h.join(child.at, first.at)).toBe(child.at);
  expect(h.transaction(isolated.tx.id).depends).not.toContain(first.tx.id);
  expect(() => h.source(revisionId("unknown"))).toThrow("UNKNOWN_REVISION");
});

test("simultaneous edits are canonical under permutation, deduplicate aliases and allow adjacency", () => {
  const a = history("A😀BC\r\n");
  const b = history("A😀BC\r\n");
  const snapshot = a.source(a.initial).snapshot();
  const edits = [
    { range: snapshot.rangeUtf16(1, 3), text: "x" },
    { range: snapshot.rangeUtf16(3, 4), text: "yz" },
    { range: snapshot.rangeUtf16(5, 7), text: "\n" },
  ];
  const prepare = (h: NativeHistory, values: typeof edits) => h.prepare({
    at: h.initial, writer: writer(), edits: values, origin: { kind: "batch" },
  })!;
  const tx = prepare(a, [...edits, edits[0]!]);
  expect(tx).toEqual(prepare(b, [...edits].reverse()));
  a.accept([tx]);
  const at = a.revision([tx.id]);
  expect(a.source(at).snapshot().text()).toBe("AxyzC\n");
  expect(snapshot.text()).toBe("A😀BC\r\n");
  for (const bad of [
    [edits[0]!, { range: edits[0]!.range, text: "other" }],
    [{ range: snapshot.rangeUtf16(1, 4), text: "" }, edits[0]!],
    [edits[0]!, { range: snapshot.rangeUtf16(3, 3), text: "x" }],
  ]) expect(() => prepare(a, bad)).toThrow(bad[0]!.range === edits[0]!.range &&
    bad[1]!.range === edits[0]!.range ? "ALIAS_EDIT_CONFLICT" : "OVERLAPPING_EDITS");
});

test("failed generation preserves history and validates boundaries, revisions, metadata and budgets", () => {
  const h = history("😀");
  const w = writer();
  const range = h.source(h.initial).snapshot().rangeUtf16(0, 0);
  const input = { at: h.initial, writer: w, edits: [{ range, text: "x" }], origin: { kind: "test" } };
  expect(() => h.prepare({ ...input, edits: [{ range: { ...range, start: 1 }, text: "x" }] }))
    .toThrow("INVALID_BOUNDARY");
  expect(() => h.prepare({ ...input, edits: [{ range: { ...range, revision: revisionId("unknown") }, text: "x" }] }))
    .toThrow("WRONG_REVISION");
  expect(() => h.prepare({ ...input, edits: [{ range, text: "\ud800" }] })).toThrow("INVALID_UNICODE");
  const cycle: Record<string, JsonValue> = {};
  cycle.self = cycle;
  for (const attribution of [cycle, NaN, { bad: undefined } as unknown as JsonValue]) {
    expect(() => h.prepare({ ...input, attribution })).toThrow("INVALID_REFERENCE");
  }
  expect(() => h.prepare({ ...input, attribution: "x".repeat(16_384) })).toThrow("LIMIT_EXCEEDED");
  expect(() => h.prepare({ ...input, edits: [{ range, text: "x".repeat(100_001) }] }))
    .toThrow("LIMIT_EXCEEDED");
  expect(h.prepare({ ...input, edits: [] })).toBe(null);
  expect(w.allocate()).toBe("t:01010101010101010101010101010101:0000000000000001");
  expect(h.source(h.initial).snapshot().text()).toBe("😀");
});

test("canonical metadata is copied without normalization and byte-budget failures do not consume IDs", () => {
  const h = history();
  const w = writer();
  const range = h.source(h.initial).snapshot().rangeUtf16(0, 0);
  const input = {
    at: h.initial, writer: w, edits: [{ range, text: "X" }], origin: { kind: "test" },
  };
  expect(() => h.prepare({ ...input, edits: [{ range, text: "x".repeat(40_000) }] }))
    .toThrow("LIMIT_EXCEEDED");
  const attribution = { z: ["e\u0301", "\r\n"], a: { actor: "not authenticated", n: -0 } };
  const tx = h.prepare({ ...input, attribution })!;
  expect(tx.id).toBe("t:01010101010101010101010101010101:0000000000000001");
  const peer = history();
  const same = peer.prepare({
    ...input, at: peer.initial, writer: writer(),
    attribution: { a: { n: 0, actor: "not authenticated" }, z: ["e\u0301", "\r\n"] },
  })!;
  expect(same).toEqual(tx);
  attribution.z[0] = "é";
  h.accept([tx]);
  expect(h.transaction(tx.id).attribution).toEqual({
    a: { actor: "not authenticated", n: 0 }, z: ["e\u0301", "\r\n"],
  });
});

test("native observed deletes preserve concurrent inserts, provenance and historical positions", () => {
  const h = history("AB");
  const old = h.source(h.initial).snapshot();
  const cut = old.anchorUtf16(1, { affinity: "after" });
  const deleted = edit(h, writer(1), h.initial, 0, 2, "");
  const inserted = edit(h, writer(2), h.initial, 1, 1, "😀");
  const joined = h.join(deleted.at, inserted.at);
  expect(h.source(joined).snapshot().text()).toBe("😀");
  expect(h.source(deleted.at).resolve(cut).status).toBe("deleted");
  const newCut = h.source(inserted.at).snapshot().anchorUtf16(1, { affinity: "after" });
  expect(h.source(h.initial).resolve(newCut).status).toBe("not-yet-created");
  expect(h.source(joined).resolve(newCut).status).toBe("present");
  expect(h.elements(joined).filter((node) => node.visible).map((node) => node.transaction))
    .toEqual([inserted.tx.id]);
  expect(h.elements(joined).filter((node) => node.visible).map((node) => node.actor))
    .toEqual([actorId("actor:2")]);
  expect(old.text()).toBe("AB");
  const hiddenB = edit(h, writer(3), h.initial, 1, 2, "");
  const x = edit(h, writer(4), hiddenB.at, 1, 1, "X");
  const insertion = x.tx.effects.find((effect) => effect.kind === "insert")!;
  expect(insertion.kind === "insert" && insertion.right).toBe(`${h.root.id}/00000001`);
});

test("acceptance stages the whole typed batch; rejects conflicts, cycles and dependencies outside the declared base", () => {
  const source = history();
  const a = edit(source, writer(), source.initial, 0, 0, "A");
  const b = edit(source, writer(2), a.at, 1, 1, "B");
  const target = history();
  const originalOrder = target.order(target.initial);
  const originalText = target.text(target.initial);
  const invalid = { ...b.tx, effects: [{ kind: "delete" as const, targets: ["unknown"] }] };
  expect(() => target.accept([a.tx, invalid])).toThrow("INVALID_REFERENCE");
  expect(target.order(target.initial)).toBe(originalOrder);
  expect(target.text(target.initial)).toBe(originalText);
  expect(() => target.revision([a.tx.id])).toThrow("UNKNOWN_REVISION");
  expect(() => target.accept([b.tx])).toThrow("MISSING_DEPENDENCIES");
  expect(() => target.accept([
    { ...a.tx, depends: [b.tx.id] }, b.tx,
  ])).toThrow("INVALID_CAUSAL_GRAPH");
  expect(target.accept([a.tx])).toBe("accepted");
  expect(target.accept([a.tx])).toBe("duplicate");
  expect(() => target.accept([{ ...a.tx, origin: { kind: "changed" } }])).toThrow("IDENTITY_CONFLICT");
  expect(() => target.accept([{ ...b.tx, depends: [] }])).toThrow("INVALID_REFERENCE");
  expect(() => target.accept([{ ...b.tx, root: "other" }])).toThrow("BASE_MISMATCH");
  expect(target.accept([b.tx, a.tx])).toBe("accepted");
  expect(target.source(target.revision([b.tx.id])).snapshot().text()).toBe("AB");
  const c = edit(source, writer(3), b.at, 2, 2, "C");
  expect(() => target.accept([{ ...c.tx, depends: [a.tx.id, b.tx.id] }])).toThrow("INVALID_CAUSAL_GRAPH");
  expect(() => target.accept([{ ...c.tx, depends: [b.tx.id, b.tx.id] }])).toThrow("INVALID_CAUSAL_GRAPH");
  expect(() => target.revision([c.tx.id])).toThrow("UNKNOWN_REVISION");
});

test("accepted metadata and effects have no writable input aliases", () => {
  const source = history();
  const tx = edit(source, writer()).tx;
  const input = JSON.parse(JSON.stringify(tx)) as NativeTransaction;
  const target = history();
  target.accept([input]);
  Object.assign(input.origin, { kind: "mutated" });
  Object.assign(input.effects[0]!, { scalar: "Z" });
  expect(target.transaction(tx.id)).toEqual(tx);
  expect(Object.isFrozen(target.transaction(tx.id).effects[0])).toBe(true);
  expect(target.source(target.revision([tx.id])).snapshot().text()).toBe("X");
});

test("private draft identities cannot collide with accepted all-zero stream identities", () => {
  const h = history();
  const w = writer(0);
  const a = edit(h, w);
  const b = edit(h, w, a.at, 1, 1, "Y");
  expect(h.source(b.at).snapshot().text()).toBe("XY");
  expect(b.tx.depends).toEqual([a.tx.id]);
});

test("deep root and inserted chains materialize iteratively without recursive stack growth", () => {
  const h = history("a".repeat(30_000));
  const inserted = edit(h, writer(), h.initial, 30_000, 30_000, "😀".repeat(20_000));
  expect(h.source(inserted.at).snapshot().lengthUtf16).toBe(70_000);
  const removed = edit(h, writer(2), inserted.at, 0, 70_000, "");
  expect(h.source(removed.at).snapshot().text()).toBe("");
  expect(h.elements(removed.at).length).toBe(50_000);
});
