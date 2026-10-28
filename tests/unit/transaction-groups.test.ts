import { expect, test } from "@lightning-js/lightning";
import type { EditingHead, RevisionEntry, RevisionSet, SourceEdit } from "../../src/contracts/core.js";
import { EditorError } from "../../src/errors.js";
import { NativeStore, type NativeHistoryBundle } from "../../src/history/native-store.js";
import { createManifest } from "../../src/history/transaction-group.js";
import { NativeHistory, type NativeTransaction } from "../../src/history/native-history.js";
import { NativeWriter } from "../../src/history/identity.js";
import { actorId, documentId, externalBaseId, replicaId, revisionId, type DocumentId } from "../../src/identity.js";

const a = documentId("group:a");
const b = documentId("group:b");
const c = documentId("group:c");
const base = externalBaseId("group:base");
function setup(stream = 1) {
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(stream++); } } });
  const initial = [
    store.createDocument({ id: a, base: { id: base, text: "A😀\r\n" } }),
    store.createDocument({ id: b, base: { id: base, text: "Z" } }),
    store.createDocument({ id: c, base: { id: base, text: "" } }),
  ];
  const writer = store.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = store.fork({ at: store.revisions(initial), writer });
  return { store, initial, writer, head };
}
function edit(head: EditingHead, document: DocumentId, text: string, start = 0, end = start): SourceEdit {
  const snapshot = head.snapshot(document);
  try { return { document, range: snapshot.rangeUtf16(start, end), text }; }
  finally { snapshot.dispose(); }
}
function contents(head: EditingHead, document: DocumentId): string {
  const snapshot = head.snapshot(document);
  try { return snapshot.text(); } finally { snapshot.dispose(); }
}
function raw(entries: readonly RevisionEntry[]): RevisionSet {
  return { entries: () => entries.values(), has: (id) => entries.some((entry) => entry.document === id),
    get: (id) => entries.find((entry) => entry.document === id)!.revision };
}
function incomplete(action: () => unknown): EditorError {
  try { action(); } catch (cause) {
    if (cause instanceof EditorError && cause.code === "INCOMPLETE_TRANSACTION_GROUP") return cause;
    throw cause;
  }
  throw new Error("expected incomplete group");
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("cross-document commit publishes one immutable manifest, receipt, checkpoint and event", async () => {
  const { store, head } = setup();
  const before = head.checkpoint();
  const old = head.snapshot(a);
  const events: unknown[] = [];
  head.onChange((event) => events.push({
    event, a: contents(head, a), b: contents(head, b), checkpoint: head.checkpoint(),
  }));
  const result = head.commit({
    expect: before, origin: { kind: "atomic" }, attribution: { source: "test" },
    edits: [edit(head, b, "b"), edit(head, a, "a")],
  });
  expect(result.documents).toEqual([a, b]);
  expect(result.transactions.length).toBe(2);
  expect(result.groups.length).toBe(1);
  expect(result.before).toBe(before);
  const manifest = store.group(result.groups[0]!);
  expect(manifest).toEqual(createManifest(manifest.members));
  expect(manifest.members.map((member) => member.document)).toEqual([a, b]);
  for (const member of manifest.members) {
    const tx = store.history.transaction(member.transaction);
    expect(tx.group).toBe(manifest.id);
    expect(member.before).toEqual(store.history.revision({
      document: member.document, revision: before.revisions.get(member.document),
    }).frontier);
    expect(member.after).toEqual([member.transaction]);
    expect(tx.after).toBe(result.after.revisions.get(member.document));
    expect(Object.isFrozen(member.before)).toBe(true);
    expect(Object.isFrozen(member)).toBe(true);
  }
  expect(Object.isFrozen(manifest.members)).toBe(true);
  expect(events).toEqual([]);
  await Promise.resolve();
  expect(events).toEqual([{ event: { change: result, reason: "commit", origin: { kind: "atomic" } },
    a: "aA😀\r\n", b: "bZ", checkpoint: result.after }]);
  expect(old.text()).toBe("A😀\r\n");
  old.dispose();
});

test("multi-document validation and aggregate budget failures do not publish prefixes or burn writer IDs", async () => {
  const { store, head } = setup();
  const before = head.checkpoint();
  const events: unknown[] = [];
  head.onChange((event) => events.push(event));
  const bad = edit(head, b, "\ud800");
  expect(() => head.commit({
    expect: before, origin: { kind: "bad" }, edits: [edit(head, a, "valid"), bad],
  })).toThrow("INVALID_UNICODE");
  expect(head.checkpoint()).toBe(before);
  expect(contents(head, a)).toBe("A😀\r\n");
  expect(contents(head, b)).toBe("Z");
  expect(store.history.transactions({ document: a, includedIn: before.revisions.get(a), limit: 10 }).items).toEqual([]);
  expect(() => head.commit({
    expect: before, origin: { kind: "too-large" }, edits: [edit(head, a, "x".repeat(20_000)), edit(head, b, "y".repeat(20_000))],
  })).toThrow("LIMIT_EXCEEDED");
  expect(head.checkpoint()).toBe(before);
  await Promise.resolve();
  expect(events).toEqual([]);
  const result = head.commit({ expect: before, origin: { kind: "valid" }, edits: [edit(head, a, "x"), edit(head, b, "y")] });
  expect(result.transactions.map((id) => id.slice(-16))).toEqual(["0000000000000001", "0000000000000002"]);
});

test("no-op documents are excluded from membership and all-no-op groups allocate nothing", () => {
  const { store, head } = setup();
  const before = head.checkpoint();
  const noChange = head.commit({
    expect: before, origin: { kind: "no-change" }, edits: [edit(head, a, "A", 0, 1), edit(head, b, "Z", 0, 1)],
  });
  expect(noChange.after).toBe(before);
  expect(noChange.groups).toEqual([]);
  const result = head.commit({
    expect: before, origin: { kind: "one-change" }, edits: [edit(head, a, "x"), edit(head, b, "Z", 0, 1)],
  });
  expect(result.documents).toEqual([a]);
  expect(result.transactions[0]!.slice(-16)).toBe("0000000000000001");
  expect(store.group(result.groups[0]!).members.map((member) => member.document)).toEqual([a]);
  expect(store.revisions([{ document: a, revision: result.after.revisions.get(a) }]).has(b)).toBe(false);
});

test("fork, merge, checkout, version construction and typed export reject the same partial group without chasing latest", () => {
  const { store, initial, writer, head } = setup();
  const result = head.commit({
    expect: head.checkpoint(), origin: { kind: "group" }, edits: [edit(head, a, "a"), edit(head, b, "b")],
  });
  const half = [{ document: a, revision: result.after.revisions.get(a) }];
  const target = raw(half);
  const peer = store.fork({ at: store.revisions(initial), writer });
  const wrongB = raw([...half, initial[1]!, initial[2]!]);
  const before = peer.checkpoint();
  const expected = [store.group(result.groups[0]!).members[1]];
  for (const action of [
    () => store.revisions(half),
    () => store.fork({ at: target, writer }),
    () => peer.merge({ expect: before, source: target }),
    () => peer.checkout({ expect: before, at: wrongB }),
    () => store.exportTyped({ target, known: store.revisions([]) }),
  ]) {
    expect(incomplete(action).details?.missing).toEqual(expected.map((member) => ({ group: result.groups[0], ...member })));
    expect(peer.checkpoint()).toBe(before);
  }
  const captured = result.after.revisions;
  head.commit({ expect: head.checkpoint(), origin: { kind: "later" }, edits: [edit(head, b, "later")] });
  const merged = peer.merge({ expect: before, source: captured });
  expect(contents(peer, a)).toBe("aA😀\r\n");
  expect(contents(peer, b)).toBe("bZ");
  expect(merged.groups).toEqual(result.groups);
  const subsetHead = store.fork({ at: store.revisions([initial[0]!]), writer });
  expect(() => subsetHead.merge({ expect: subsetHead.checkpoint(), source: captured })).toThrow("DOCUMENT_NOT_IN_HEAD");
  expect(subsetHead.checkpoint().revisions.has(b)).toBe(false);
});

test("typed group transfer is atomic, target-exact, domain-bound and never moves receiving heads", () => {
  const sender = setup(10);
  const receiver = setup(90);
  const result = sender.head.commit({
    expect: sender.head.checkpoint(), origin: { kind: "transfer" },
    edits: [edit(sender.head, a, "a"), edit(sender.head, b, "b")],
  });
  const bundle = sender.store.exportTyped({ target: result.after.revisions, known: sender.store.revisions(sender.initial) });
  const before = receiver.head.checkpoint();
  const accepted = receiver.store.acceptBundle(copy(bundle));
  expect(accepted.status).toBe("accepted");
  expect([...accepted.availableRevisions.entries()]).toEqual([...result.after.revisions.entries()]);
  expect(receiver.head.checkpoint()).toBe(before);
  expect(receiver.store.acceptBundle(bundle).status).toBe("duplicate");
  expect(receiver.store.group(result.groups[0]!)).toEqual(sender.store.group(result.groups[0]!));
  expect(() => sender.store.exportTyped({ target: result.after.revisions, documents: [a] })).toThrow("SYNC_SCOPE_MISMATCH");
  const excluded = setup(100);
  expect(() => excluded.store.acceptBundle(bundle, { documents: [a] })).toThrow("SYNC_SCOPE_MISMATCH");
  expect(() => excluded.store.history.transaction(result.transactions[0]!)).toThrow("INVALID_REFERENCE");
  const half: NativeHistoryBundle = {
    ...copy(bundle), histories: bundle.histories.filter((history) => history.document !== b),
    target: bundle.target.filter((entry) => entry.document !== b),
  };
  const fresh = setup(110);
  expect(incomplete(() => fresh.store.acceptBundle(half)).details?.missing).toEqual([
    { group: result.groups[0], ...sender.store.group(result.groups[0]!).members[1] },
  ]);
  expect(() => fresh.store.history.transaction(result.transactions[0]!)).toThrow("INVALID_REFERENCE");
  const corrupted = copy(bundle);
  const tx = corrupted.histories.find((history) => history.document === b)!.transactions[0]!;
  Object.assign(tx.effects[0]!, { left: "unknown" });
  expect(() => fresh.store.acceptBundle(corrupted)).toThrow("INVALID_REFERENCE");
  expect(() => fresh.store.history.transaction(result.transactions[0]!)).toThrow("INVALID_REFERENCE");
  receiver.head.merge({ expect: before, source: accepted.availableRevisions });
  expect(contents(receiver.head, a)).toBe("aA😀\r\n");
  expect(contents(receiver.head, b)).toBe("bZ");
});

test("membership is digest-bound, cannot be laundered through singleton acceptance, and preserves detached values", () => {
  const sender = setup(20);
  const result = sender.head.commit({
    expect: sender.head.checkpoint(), origin: { kind: "binding" }, edits: [edit(sender.head, a, "a"), edit(sender.head, b, "b")],
  });
  const bundle = sender.store.exportTyped({ target: result.after.revisions });
  const fresh = setup(100);
  const first = bundle.histories.find((history) => history.document === a)!;
  expect(incomplete(() => fresh.store.accept({ document: a, transactions: first.transactions })).details?.missingManifests)
    .toEqual(result.groups);
  const shortened = { ...copy(bundle), manifests: [{ ...bundle.manifests[0]!, members: [bundle.manifests[0]!.members[0]!] }] };
  expect(() => fresh.store.acceptBundle(shortened)).toThrow("IDENTITY_CONFLICT");
  const rebound = { ...shortened, manifests: [createManifest(shortened.manifests[0]!.members)] };
  expect(() => fresh.store.acceptBundle(rebound)).toThrow("IDENTITY_CONFLICT");
  expect(() => fresh.store.history.transaction(result.transactions[0]!)).toThrow("INVALID_REFERENCE");
  const mutable = copy(bundle);
  fresh.store.acceptBundle(mutable);
  Object.assign(mutable.manifests[0]!.members[0]!, { root: "mutated" });
  Object.assign(mutable.histories[0]!.transactions[0]!.effects[0]!, { scalar: "mutated" });
  expect(fresh.store.group(result.groups[0]!)).toEqual(bundle.manifests[0]);
  const snapshot = fresh.store.snapshot({ document: a, revision: result.after.revisions.get(a) });
  expect(snapshot.text()).toBe("aA😀\r\n");
  snapshot.dispose();
  // A registered A member is not evidence of B membership or its exact root.
  const justA = new NativeStore();
  justA.createDocument({ id: a, base: { id: base, text: "A😀\r\n" } });
  const half = { ...bundle, histories: [first], target: bundle.target.filter((target) => target.document === a) };
  expect(incomplete(() => justA.acceptBundle(half)).details?.missing).toEqual([
    { group: result.groups[0], ...bundle.manifests[0]!.members[1] },
  ]);
});

test("missing-member reports include transitive groups, even when required payloads are absent", () => {
  const sender = setup(30);
  const first = sender.head.commit({
    expect: sender.head.checkpoint(), origin: { kind: "first" }, edits: [edit(sender.head, a, "a"), edit(sender.head, b, "b")],
  });
  const second = sender.head.commit({
    expect: sender.head.checkpoint(), origin: { kind: "second" }, edits: [edit(sender.head, b, "2"), edit(sender.head, c, "c")],
  });
  const target = raw([{ document: c, revision: second.after.revisions.get(c) }]);
  const expected = [sender.store.group(first.groups[0]!), sender.store.group(second.groups[0]!)]
    .sort((a, b) => a.id < b.id ? -1 : 1)
    .flatMap((manifest) => manifest.members.filter((member) => member.document !== c).map((member) => ({ group: manifest.id, ...member })));
  expect(incomplete(() => sender.store.fork({ at: target, writer: sender.writer })).details?.missing).toEqual(expected);
  const bundle = sender.store.exportTyped({ target: second.after.revisions });
  const half = { ...bundle, histories: bundle.histories.filter((history) => history.document === c),
    target: bundle.target.filter((entry) => entry.document === c) };
  const receiver = setup(110);
  expect(incomplete(() => receiver.store.acceptBundle(half)).details?.missing).toEqual(expected);
  expect(() => receiver.store.history.transaction(second.transactions[1]!)).toThrow("INVALID_REFERENCE");
});

function graphFixture() {
  const A = new NativeHistory({ document: a, base, text: "" });
  const B = new NativeHistory({ document: b, base, text: "" });
  const writer = new NativeWriter({ actor: actorId("graph"), replica: replicaId("graph"), random: { fill(bytes) { bytes.fill(50); } } });
  const append = (history: NativeHistory, at = history.initial): NativeTransaction => {
    const tx = history.prepare({
      at, writer, origin: { kind: "graph" },
      edits: [{ range: history.source(at).snapshot().rangeUtf16(0, 0), text: "x" }],
    })!;
    history.accept([tx]); return tx;
  };
  const a0 = append(A), a1 = append(A, A.revision([a0.id]));
  const b0 = append(B), b1 = append(B, B.revision([b0.id])), isolatedB = append(B);
  const member = (history: NativeHistory, tx: NativeTransaction) => ({
    document: history.root.document, base, root: history.root.id,
    transaction: tx.id, before: tx.depends, after: [tx.id],
  });
  const receiver = new NativeStore();
  receiver.createDocument({ id: a, base: { id: base, text: "" } });
  receiver.createDocument({ id: b, base: { id: base, text: "" } });
  return { A, B, a0, a1, b0, b1, isolatedB, member, receiver };
}

test("cross-document group dependency cycles reject although each source graph is acyclic", () => {
  const { A, B, a0, a1, b0, b1, member, receiver } = graphFixture();
  const g1 = createManifest([member(A, a1), member(B, b0)]);
  const g2 = createManifest([member(A, a0), member(B, b1)]);
  const bundle: NativeHistoryBundle = {
    manifests: [g1, g2],
    histories: [
      { document: a, root: A.root.id, transactions: [{ ...a0, group: g2.id }, { ...a1, group: g1.id }] },
      { document: b, root: B.root.id, transactions: [{ ...b0, group: g1.id }, { ...b1, group: g2.id }] },
    ],
    target: [{ document: a, root: A.root.id, frontier: [a1.id] }, { document: b, root: B.root.id, frontier: [b1.id] }],
  };
  expect(() => receiver.acceptBundle(bundle)).toThrow("cross-document group dependency cycle");
  expect(() => receiver.history.transaction(a0.id)).toThrow("INVALID_REFERENCE");
  expect(() => receiver.group(g1.id)).toThrow("INVALID_REFERENCE");
});

test("a closed final target cannot repair inconsistent before vectors of the same atomic group", () => {
  const { A, B, a0, a1, b0, isolatedB, member, receiver } = graphFixture();
  const g1 = createManifest([member(A, a0), member(B, b0)]);
  const g2 = createManifest([member(A, a1), member(B, isolatedB)]);
  const bundle: NativeHistoryBundle = {
    manifests: [g1, g2],
    histories: [
      { document: a, root: A.root.id, transactions: [{ ...a0, group: g1.id }, { ...a1, group: g2.id }] },
      { document: b, root: B.root.id, transactions: [{ ...b0, group: g1.id }, { ...isolatedB, group: g2.id }] },
    ],
    target: [{ document: a, root: A.root.id, frontier: [a1.id] }, { document: b, root: B.root.id, frontier: [b0.id, isolatedB.id] }],
  };
  expect(() => receiver.acceptBundle(bundle)).toThrow("inconsistent causal bases");
  expect(() => receiver.history.transaction(a0.id)).toThrow("INVALID_REFERENCE");
});

test("typed export uses exact causal differences and falls back safely for unknown peer knowledge", () => {
  const sender = setup(40);
  const first = sender.head.commit({
    expect: sender.head.checkpoint(), origin: { kind: "first" }, edits: [edit(sender.head, a, "a"), edit(sender.head, b, "b")],
  });
  const receiver = setup(120);
  receiver.store.acceptBundle(sender.store.exportTyped({ target: first.after.revisions }));
  const second = sender.head.commit({
    expect: sender.head.checkpoint(), origin: { kind: "second" }, edits: [edit(sender.head, b, "2")],
  });
  const delta = sender.store.exportTyped({ target: second.after.revisions, known: first.after.revisions });
  expect(delta.histories.flatMap((history) => history.transactions.map((tx) => tx.id))).toEqual(second.transactions);
  expect(receiver.store.acceptBundle(delta).availableRevisions.get(b)).toBe(second.after.revisions.get(b));
  const halfKnown = raw([{ document: a, revision: first.after.revisions.get(a) }]);
  expect(incomplete(() => sender.store.exportTyped({ target: second.after.revisions, known: halfKnown })).details?.missing).toEqual([
    { group: first.groups[0], ...sender.store.group(first.groups[0]!).members[1] },
  ]);
  const unknown = raw([{ document: a, revision: revisionId("peer:unknown") }]);
  const full = sender.store.exportTyped({ target: first.after.revisions, known: unknown });
  expect(full.histories.flatMap((history) => history.transactions.map((tx) => tx.id))).toEqual(first.transactions);
  const newerKnown = sender.store.exportTyped({ target: first.after.revisions, known: second.after.revisions });
  expect(newerKnown.histories.flatMap((history) => history.transactions)).toEqual([]);
  const oldTarget = receiver.store.acceptBundle(newerKnown);
  expect(oldTarget.status).toBe("duplicate");
  expect(oldTarget.availableRevisions.get(b)).toBe(first.after.revisions.get(b));
  expect(receiver.head.checkpoint().revisions.get(b)).toBe(receiver.initial[1]!.revision);
  const isolated = sender.store.fork({ at: sender.store.revisions(sender.initial), writer: sender.writer });
  const concurrent = isolated.commit({
    expect: isolated.checkpoint(), origin: { kind: "isolated" }, edits: [edit(isolated, a, "other"), edit(isolated, b, "other")],
  });
  const olderCounters = sender.store.exportTyped({ target: first.after.revisions, known: concurrent.after.revisions });
  expect(olderCounters.histories.flatMap((history) => history.transactions.map((tx) => tx.id))).toEqual(first.transactions);
});

test("cross-document input permutation produces the same distributed identities and manifests", () => {
  const one = setup(60), two = setup(60);
  const commit = (head: EditingHead, reverse: boolean) => {
    const edits = [edit(head, a, "a"), edit(head, b, "b"), edit(head, c, "c")];
    return head.commit({ expect: head.checkpoint(), origin: { kind: "canonical" }, edits: reverse ? edits.reverse() : edits });
  };
  const first = commit(one.head, false), second = commit(two.head, true);
  expect(first.groups).toEqual(second.groups);
  expect(first.transactions).toEqual(second.transactions);
  expect(one.store.exportTyped({ target: first.after.revisions })).toEqual(two.store.exportTyped({ target: second.after.revisions }));
});
