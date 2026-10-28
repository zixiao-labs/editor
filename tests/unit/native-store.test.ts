import { expect, test } from "@lightning-js/lightning";
import type { CommitReceipt, EditingHead, RevisionSet, SourceEdit } from "../../src/contracts/core.js";
import {
  actorId, documentId, externalBaseId, replicaId, revisionId, type DocumentId, type HistoryCursor,
} from "../../src/identity.js";
import { NativeStore } from "../../src/history/native-store.js";
import { NativeHistory } from "../../src/history/native-history.js";
import { NativeWriter } from "../../src/history/identity.js";
import { EditorError } from "../../src/errors.js";

const document = documentId("store:document");
const other = documentId("store:other");
const base = externalBaseId("store:base");
function store() {
  let nonce = 1;
  return new NativeStore({ random: { fill(bytes) { bytes.fill(nonce++); } } });
}
function setup(text = "AB") {
  const s = store();
  const initial = s.createDocument({ id: document, base: { id: base, text } });
  const writer = s.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = s.fork({ at: s.revisions([initial]), writer });
  return { s, initial, writer, head };
}
function contents(head: EditingHead, source = document): string {
  const snapshot = head.snapshot(source);
  try { return snapshot.text(); } finally { snapshot.dispose(); }
}
function sourceEdit(head: EditingHead, start: number, end: number, text: string, source = document): SourceEdit {
  const snapshot = head.snapshot(source);
  try { return { document: source, range: snapshot.rangeUtf16(start, end), text }; }
  finally { snapshot.dispose(); }
}
function commit(head: EditingHead, start: number, end: number, text: string): CommitReceipt {
  return head.commit({ expect: head.checkpoint(), edits: [sourceEdit(head, start, end, text)], origin: { kind: "test" } });
}
const flush = async () => { await Promise.resolve(); };

test("document registrations are exact and idempotent; revision sets copy and freeze source entries", () => {
  const s = store();
  const initial = s.createDocument({ id: document, base: { id: base, text: "A😀\r\n" } });
  expect(s.createDocument({ id: document, base: { id: base, text: "A😀\r\n" } })).toEqual(initial);
  for (const registration of [
    { id: base, text: "A😀\n" }, { id: externalBaseId("other"), text: "A😀\r\n" },
  ]) expect(() => s.createDocument({ id: document, base: registration })).toThrow("BASE_MISMATCH");
  const input = [{ ...initial }];
  const set = s.revisions(input);
  input[0]!.revision = revisionId("mutated");
  input.length = 0;
  expect(set.get(document)).toBe(initial.revision);
  expect([...set.entries()]).toEqual([initial]);
  expect(Object.isFrozen([...set.entries()][0])).toBe(true);
  expect(Object.isFrozen(set)).toBe(true);
  expect(() => set.get(other)).toThrow("UNKNOWN_DOCUMENT");
  expect(() => s.snapshot({ document: other, revision: initial.revision })).toThrow("UNKNOWN_DOCUMENT");
  expect(() => s.revisions([{ document, revision: revisionId("unknown") }])).toThrow("UNKNOWN_REVISION");
  expect(store().createDocument({ id: document, base: { id: base, text: "A😀\r\n" } })).toEqual(initial);
});

test("writer ownership, stream uniqueness and borrowing are enforced without actor-based uniqueness", () => {
  const { s, initial, writer, head } = setup();
  const second = s.openWriter({ actor: writer.actor, replica: writer.replica });
  const peer = store();
  peer.createDocument({ id: document, base: { id: base, text: "AB" } });
  expect(() => peer.fork({ at: peer.revisions([initial]), writer })).toThrow("DIFFERENT_ATOMIC_DOMAIN");
  expect(() => writer.dispose()).toThrow("RESOURCE_IN_USE");
  head.dispose();
  writer.dispose();
  writer.dispose();
  expect(() => s.fork({ at: s.revisions([initial]), writer })).toThrow("DISPOSED");
  second.dispose();
  s.dispose();
  const collision = new NativeStore({ random: { fill(bytes) { bytes.fill(7); } } });
  const one = collision.openWriter({ actor: actorId("a"), replica: replicaId("r") });
  expect(() => collision.openWriter({ actor: actorId("b"), replica: replicaId("r") })).toThrow("IDENTITY_CONFLICT");
  one.dispose();
  expect(() => collision.openWriter({ actor: actorId("a"), replica: replicaId("r") })).toThrow("IDENTITY_CONFLICT");
});

test("forks isolate shared-writer streams and pinned merges never chase the source head", () => {
  const { s, initial, writer, head } = setup("");
  const isolated = s.fork({ at: s.revisions([initial]), writer });
  const a = commit(head, 0, 0, "A");
  const b = commit(isolated, 0, 0, "B");
  expect(contents(head)).toBe("A");
  expect(contents(isolated)).toBe("B");
  expect(s.history.transaction(b.transactions[0]!).dependencies).toEqual([]);
  const pinned = b.after.revisions;
  const c = commit(isolated, 1, 1, "C");
  const merged = head.merge({ expect: head.checkpoint(), source: pinned });
  expect(contents(head)).toBe("AB");
  expect(contents(isolated)).toBe("BC");
  expect(s.history.compare({
    document, left: merged.after.revisions.get(document), right: c.after.revisions.get(document),
  })).toBe("concurrent");
  expect(s.history.compare({
    document, left: a.after.revisions.get(document), right: merged.after.revisions.get(document),
  })).toBe("ancestor");
  expect(s.history.transaction(b.transactions[0]!).actor).toBe(writer.actor);
});

test("CAS rejects stale and foreign checkpoints, including checkout ABA with identical revision contents", () => {
  const { s, initial, writer, head } = setup();
  const before = head.checkpoint();
  const peer = s.fork({ at: s.revisions([initial]), writer });
  commit(head, 0, 0, "X");
  expect(() => head.commit({ expect: before, edits: [], origin: { kind: "stale" } })).toThrow("STALE_CHECKPOINT");
  const reverted = head.checkout({ expect: head.checkpoint(), at: before.revisions });
  expect(reverted.after.revisions.get(document)).toBe(before.revisions.get(document));
  expect(reverted.after.stamp).not.toBe(before.stamp);
  expect(contents(head)).toBe("AB");
  expect(reverted.transactions).toEqual([]);
  expect(() => head.merge({ expect: before, source: peer.checkpoint().revisions })).toThrow("STALE_CHECKPOINT");
  expect(() => head.checkout({ expect: peer.checkpoint(), at: before.revisions })).toThrow("STALE_CHECKPOINT");
  const receipt = head.commit({ expect: head.checkpoint(), edits: [], origin: { kind: "empty" } });
  expect(receipt.status).toBe("no-change");
  expect(receipt.after).toBe(receipt.before);
  expect(s.ownsReceipt(receipt)).toBe(true);
  expect(s.ownsReceipt({ ...receipt } as CommitReceipt)).toBe(false);
  expect(Object.isFrozen(receipt.documents)).toBe(true);
});

test("head membership is fixed; merge allows subsets and checkout requires the exact member set", () => {
  const { s, initial, writer, head } = setup();
  const second = s.createDocument({ id: other, base: { id: base, text: "Z" } });
  const many = s.fork({ at: s.revisions([second, initial]), writer });
  expect(many.document(other)).toEqual({ head: many, document: other });
  expect(() => head.snapshot(other)).toThrow("DOCUMENT_NOT_IN_HEAD");
  expect(() => head.merge({ expect: head.checkpoint(), source: s.revisions([second]) })).toThrow("DOCUMENT_NOT_IN_HEAD");
  expect(() => many.checkout({ expect: many.checkpoint(), at: s.revisions([initial]) })).toThrow("DOCUMENT_NOT_IN_HEAD");
  const changed = commit(head, 0, 1, "X");
  many.merge({ expect: many.checkpoint(), source: changed.after.revisions });
  expect(contents(many)).toBe("XB");
  expect(contents(many, other)).toBe("Z");
  const before = many.checkpoint();
  const grouped = many.commit({
    expect: before, edits: [sourceEdit(many, 0, 1, "a"), sourceEdit(many, 0, 1, "b", other)],
    origin: { kind: "atomic-group" },
  });
  expect(grouped.groups.length).toBe(1);
  expect(grouped.transactions.length).toBe(2);
  expect(grouped.before).toBe(before);
  expect(contents(many)).toBe("aB");
  expect(contents(many, other)).toBe("b");
});

test("invalid and no-change commits preserve heads, history and canonical batch conflict rules", () => {
  const { s, head } = setup("A😀B");
  const before = head.checkpoint();
  const first = sourceEdit(head, 0, 1, "Z");
  const bad = sourceEdit(head, 1, 3, "x");
  expect(() => head.commit({
    expect: before, edits: [first, { ...bad, range: { ...bad.range, end: 2 } }], origin: { kind: "bad" },
  })).toThrow("INVALID_BOUNDARY");
  expect(head.checkpoint()).toBe(before);
  expect(s.history.transactions({ document, includedIn: before.revisions.get(document), limit: 10 }).items).toEqual([]);
  const same = sourceEdit(head, 0, 1, "A");
  const noChange = head.commit({ expect: before, edits: [same], origin: { kind: "same" } });
  expect(noChange.status).toBe("no-change");
  expect(noChange.transactions).toEqual([]);
  expect(noChange.after).toBe(before);
  const cancelled = head.commit({
    expect: before, origin: { kind: "net-no-change" },
    edits: [sourceEdit(head, 0, 1, ""), sourceEdit(head, 1, 3, "A😀")],
  });
  expect(cancelled.status).toBe("no-change");
  expect(cancelled.after).toBe(before);
  expect(cancelled.transactions).toEqual([]);
  expect(() => head.commit({
    expect: before, edits: [same, first], origin: { kind: "alias" },
  })).toThrow("ALIAS_EDIT_CONFLICT");
  const result = head.commit({
    expect: before, edits: [first, first, sourceEdit(head, 3, 4, "Y")], origin: { kind: "batch" },
  });
  expect(contents(head)).toBe("Z😀Y");
  expect(result.transactions.length).toBe(1);
  expect(result.groups.length).toBe(1);
  expect(result.before).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
});

test("typed history acceptance makes exact revisions queryable but never moves any head", () => {
  const { s, initial, head } = setup();
  const native = new NativeHistory({ document, base, text: "AB" });
  const w = new NativeWriter({
    actor: actorId("remote"), replica: replicaId("remote"), random: { fill(bytes) { bytes.fill(50); } },
  });
  const tx = native.prepare({
    at: native.initial, writer: w, origin: { kind: "remote" },
    edits: [{ range: native.source(native.initial).snapshot().rangeUtf16(1, 1), text: "X" }],
  })!;
  const before = head.checkpoint();
  const accepted = s.accept({ document, transactions: [tx] });
  expect(accepted.status).toBe("accepted");
  expect(head.checkpoint()).toBe(before);
  expect(contents(head)).toBe("AB");
  const snapshot = s.snapshot(accepted.at);
  expect(snapshot.text()).toBe("AXB");
  snapshot.dispose();
  expect(s.accept({ document, transactions: [tx] }).status).toBe("duplicate");
  const cut = head.snapshot(document);
  const position = cut.anchorUtf16(1, { affinity: "after" });
  cut.dispose();
  expect(() => s.history.resolve({ position, at: { document, revision: revisionId("unknown") } }))
    .toThrow("UNKNOWN_REVISION");
  head.merge({ expect: before, source: s.revisions([accepted.at]) });
  expect(contents(head)).toBe("AXB");
  expect(s.history.revision(initial).parents).toEqual([]);
  expect(s.history.revision(accepted.at).parents).toEqual([initial.revision]);
});

test("typed acceptance rejects invalid batches and cross-document or locally leased transaction identities atomically", () => {
  const { s, initial, head } = setup();
  const second = s.createDocument({ id: other, base: { id: base, text: "AB" } });
  const make = (source: DocumentId, nonce: number) => {
    const native = new NativeHistory({ document: source, base, text: "AB" });
    const writer = new NativeWriter({
      actor: actorId("sender"), replica: replicaId("sender"), random: { fill(bytes) { bytes.fill(nonce); } },
    });
    return native.prepare({
      at: native.initial, writer, origin: { kind: "remote" },
      edits: [{ range: native.source(native.initial).snapshot().rangeUtf16(0, 0), text: "X" }],
    })!;
  };
  const remote = make(document, 60);
  const before = head.checkpoint();
  expect(() => s.accept({ document, transactions: [remote, {
    ...remote, id: make(document, 61).id, effects: [{ kind: "delete", targets: ["unknown"] }],
  }] })).toThrow("INVALID_REFERENCE");
  expect(() => s.history.transaction(remote.id)).toThrow("INVALID_REFERENCE");
  expect(head.checkpoint()).toBe(before);
  expect(s.history.transactions({ document, includedIn: initial.revision, limit: 10 }).items).toEqual([]);
  expect(() => s.accept({ document, transactions: [make(document, 1)] })).toThrow("IDENTITY_CONFLICT");
  s.accept({ document, transactions: [remote] });
  expect(() => s.accept({ document: other, transactions: [make(other, 60)] })).toThrow("IDENTITY_CONFLICT");
  expect(s.history.transactions({ document: other, includedIn: second.revision, limit: 10 }).items).toEqual([]);
  expect(contents(head)).toBe("AB");
});

test("queries paginate canonical causal history, bind cursors and preserve provenance and position distinctions", () => {
  const { s, initial, head } = setup("A😀B");
  const old = head.snapshot(document);
  const deleted = old.anchorUtf16(1, { affinity: "after" });
  const first = commit(head, 1, 3, "xy");
  const inserted = head.snapshot(document);
  const future = inserted.anchorUtf16(1, { affinity: "after" });
  const second = commit(head, 0, 0, "Z");
  const at = second.after.revisions.get(document);
  const page = s.history.transactions({ document, includedIn: at, limit: 1 });
  expect(page.items.map((tx) => tx.id)).toEqual(first.transactions);
  expect(page.next).not.toBe(null);
  const next = s.history.transactions({ document, includedIn: at, limit: 2, cursor: page.next! });
  expect(next.items.map((tx) => tx.id)).toEqual(second.transactions);
  expect(next.next).toBe(null);
  expect(() => s.history.transactions({
    document, includedIn: first.after.revisions.get(document), limit: 1, cursor: page.next!,
  })).toThrow("WRONG_REVISION");
  expect(() => s.history.transactions({ document, includedIn: at, limit: 0 })).toThrow("INVALID_RANGE");
  expect(() => s.history.transactions({ document, includedIn: at, limit: 1, cursor: "fake" as HistoryCursor }))
    .toThrow("INVALID_REFERENCE");
  expect(s.history.resolve({ position: deleted, at: { document, revision: at } }).status).toBe("deleted");
  expect(s.history.resolve({ position: future, at: initial }).status).toBe("not-yet-created");
  const snapshot = head.snapshot(document);
  const spans = s.history.provenance({ document, revision: at, range: snapshot.rangeUtf16(0, snapshot.lengthUtf16) });
  expect(spans.map((span) => [span.range.start, span.range.end, span.transaction])).toEqual([
    [0, 1, second.transactions[0]], [1, 2, null], [2, 4, first.transactions[0]], [4, 5, null],
  ]);
  expect(Object.isFrozen(spans[0]!.range)).toBe(true);
  expect(s.history.translate({ point: old.pointUtf16(0), to: at, affinity: "before" }).status).toBe("present");
  expect(old.text()).toBe("A😀B");
  old.dispose();
  inserted.dispose();
  snapshot.dispose();
});

test("merge revisions have deterministic immediate causal parents and no-change merges do not advance stamps", () => {
  const { s, initial, writer, head } = setup("");
  const branch = s.fork({ at: s.revisions([initial]), writer });
  const a = commit(head, 0, 0, "a");
  const b = commit(branch, 0, 0, "b");
  const merge = head.merge({ expect: head.checkpoint(), source: b.after.revisions });
  expect(s.history.revision({ document, revision: merge.after.revisions.get(document) }).parents)
    .toEqual([b.after.revisions.get(document), a.after.revisions.get(document)]);
  expect(merge.transactions).toEqual(b.transactions);
  expect(s.history.compare({
    document, left: merge.after.revisions.get(document), right: a.after.revisions.get(document),
  })).toBe("descendant");
  const noChange = head.merge({ expect: head.checkpoint(), source: a.after.revisions });
  expect(noChange.status).toBe("no-change");
  expect(noChange.after).toBe(noChange.before);
});

test("events publish in commit-order microtasks, reject synchronous writes and isolate listener failures", async () => {
  const errors: EditorError[] = [];
  let nonce = 1;
  const s = new NativeStore({
    random: { fill(bytes) { bytes.fill(nonce++); } }, onError(error) { errors.push(error); },
  });
  const initial = s.createDocument({ id: document, base: { id: base, text: "" } });
  const w = s.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = s.fork({ at: s.revisions([initial]), writer: w });
  const delivered: CommitReceipt[] = [];
  const observed: string[] = [];
  head.onChange(() => { throw new Error("listener failed"); });
  head.onChange((event) => {
    delivered.push(event.change);
    observed.push(contents(head));
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => head.commit({ expect: head.checkpoint(), edits: [], origin: { kind: "reentrant" } }))
      .toThrow("REENTRANT_WRITE");
    expect(() => s.createDocument({ id: other, base: { id: base, text: "" } })).toThrow("REENTRANT_WRITE");
  });
  const first = commit(head, 0, 0, "A");
  const second = commit(head, 1, 1, "B");
  expect(delivered).toEqual([]);
  await flush();
  expect(delivered).toEqual([first, second]);
  expect(observed).toEqual(["AB", "AB"]);
  expect(errors.length).toBe(2);
  expect(errors[0]!.cause).toBeInstanceOf(Error);
  // A later turn/microtask, not a listener's synchronous stack, can write.
  commit(head, 2, 2, "C");
  await flush();
  expect(contents(head)).toBe("ABC");
});

test("same-revision checkout is a stamped lifecycle event; unsubscribe cancels queued delivery", async () => {
  const { head } = setup();
  const reasons: string[] = [];
  const subscription = head.onChange((event) => { reasons.push(event.reason); });
  const before = head.checkpoint();
  const receipt = head.checkout({ expect: before, at: before.revisions });
  expect(receipt.status).toBe("no-change");
  expect(receipt.after.stamp).not.toBe(before.stamp);
  await flush();
  expect(reasons).toEqual(["checkout"]);
  commit(head, 0, 0, "x");
  subscription.dispose();
  subscription.dispose();
  await flush();
  expect(reasons).toEqual(["checkout"]);
});

test("store, writer, head and snapshot borrowing release independently without cascading disposal", async () => {
  const { s, initial, writer, head } = setup();
  const snapshot = head.snapshot(document);
  const revisions = head.checkpoint().revisions;
  expect(() => s.dispose()).toThrow("RESOURCE_IN_USE");
  head.dispose();
  head.dispose();
  expect(() => head.snapshot(document)).toThrow("DISPOSED");
  writer.dispose();
  expect(() => s.dispose()).toThrow("RESOURCE_IN_USE");
  expect(snapshot.text()).toBe("AB");
  snapshot.dispose();
  snapshot.dispose();
  expect(() => snapshot.text()).toThrow("DISPOSED");
  await flush();
  s.dispose();
  s.dispose();
  expect(() => s.snapshot(initial)).toThrow("DISPOSED");
  expect(() => s.history.revision(initial)).toThrow("DISPOSED");
  expect(revisions.get(document)).toBe(initial.revision);
});

test("caller-supplied live revision iterables are captured once; nested writes cannot leak partial state", () => {
  const { s, head } = setup();
  const before = head.checkpoint();
  let calls = 0;
  const source: RevisionSet = {
    get: before.revisions.get, has: before.revisions.has,
    entries() {
      calls++;
      expect(() => s.createDocument({ id: other, base: { id: base, text: "" } })).toThrow("REENTRANT_WRITE");
      return before.revisions.entries();
    },
  };
  head.merge({ expect: before, source });
  expect(calls).toBe(1);
  expect(head.checkpoint()).toBe(before);
  expect(() => head.merge({ expect: before, source: head as unknown as RevisionSet })).toThrow("INVALID_REFERENCE");
});

test("version entries are copied at iteration time and read once before validation", () => {
  const { s, initial, head } = setup();
  let reads = 0;
  const entry = {
    document, get revision() { reads++; return reads === 1 ? initial.revision : revisionId("unvalidated"); },
  };
  expect(s.revisions([entry]).get(document)).toBe(initial.revision);
  expect(reads).toBe(1);
  const source = {
    get: head.checkpoint().revisions.get, has: head.checkpoint().revisions.has,
    *entries() {
      const item = { ...initial };
      yield item;
      item.revision = revisionId("mutated after yield");
    },
  };
  head.merge({ expect: head.checkpoint(), source });
  expect(head.checkpoint().revisions.get(document)).toBe(initial.revision);
});
