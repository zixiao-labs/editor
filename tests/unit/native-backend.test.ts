import { expect, test } from "@lightning-js/lightning";
import {
  assertHistoryBackendCompatibility, createHistoryStore, decodeHistoryBundle, decodePositionToken,
  defineHistoryBackend, documentId, encodeHistoryBundle, encodePositionToken, externalBaseId, actorId,
  replicaId, historyBackendId, historyStoreFor, EditorError,
} from "../../src/index.js";
import type {
  CommitReceipt, EditingHead, HistoryBundle, HistoryStore, HistoryStoreOptions, RevisionSet, SourceEdit,
  TransactionInfo,
} from "../../src/index.js";
import type { NativeHistoryBundle } from "../../src/history/native-store.js";
import { NativeHistory } from "../../src/history/native-history.js";
import { NativeWriter } from "../../src/history/identity.js";
import { createManifest } from "../../src/history/transaction-group.js";
import { canonicalCopy } from "../../src/history/canonical.js";
import { nativeContextState } from "../../src/native-backend.js";
import { backendDouble } from "./support/backend-double.js";

const document = documentId("native:document");
const base = externalBaseId("native:base");
let serial = 1_000;
function store(options: Partial<HistoryStoreOptions> = {}): HistoryStore {
  return createHistoryStore({ random: { fill(bytes) { bytes.fill(serial++); } }, ...options });
}
function registered(target: HistoryStore, text = "AB") {
  return target.createDocument({ id: document, base: { id: base, text } });
}
function open(target: HistoryStore, entries: readonly ReturnType<typeof registered>[], name = "native:actor") {
  const writer = target.openWriter({ actor: actorId(name), replica: replicaId("native:replica") });
  return { writer, head: target.fork({ at: target.revisions(entries), writer }) };
}
function edit(head: EditingHead, start: number, end: number, text: string): SourceEdit {
  const snapshot = head.snapshot(document);
  try { return { document, range: snapshot.rangeUtf16(start, end), text }; }
  finally { snapshot.dispose(); }
}
function commit(head: EditingHead, edits: readonly SourceEdit[], kind = "test"): CommitReceipt {
  return head.commit({ expect: head.checkpoint(), edits, origin: { kind } });
}
function contents(head: EditingHead): string {
  const snapshot = head.snapshot(document);
  try { return snapshot.text(); } finally { snapshot.dispose(); }
}
const flush = async () => { await Promise.resolve(); };
function codeOf(action: () => unknown): string | undefined {
  try { action(); return undefined; } catch (cause) { return (cause as { code?: string }).code; }
}
const bundles = nativeContextState.api.bundles<NativeHistoryBundle>();
function kernelTransaction(seed: number, text: string, after?: Readonly<{ kernel: NativeHistory; id: string }>) {
  const kernel = new NativeHistory({ document, base, text: "AB" });
  if (after) kernel.accept([after.kernel.transaction(after.id as never)]);
  const writer = new NativeWriter({ actor: actorId("fixture"), replica: replicaId("fixture"), random: { fill(b) { b.fill(seed); } } });
  const at = after ? kernel.revision([after.id as never]) : kernel.initial;
  const tx = kernel.prepare({
    at, writer, origin: { kind: "remote" },
    edits: [{ range: kernel.source(at).snapshot().rangeUtf16(0, 0), text }],
  })!;
  kernel.accept([tx]);
  writer.dispose();
  return { kernel, tx };
}
function bundleOf(kernel: NativeHistory, transactions: readonly ReturnType<typeof kernelTransaction>["tx"][]): HistoryBundle {
  return bundles.create(canonicalCopy({
    manifests: transactions.map((tx) => createManifest([{
      document, base, root: kernel.root.id, transaction: tx.id, before: tx.depends, after: [tx.id],
    }])),
    histories: [{ document, root: kernel.root.id, transactions }],
    target: [{ document, root: kernel.root.id, frontier: transactions.map((tx) => tx.id).sort() }],
  } satisfies NativeHistoryBundle));
}
/** P depends on M; delivering only P must defer until M arrives. */
function pendingPair(seedM = 41, seedP = 51) {
  const m = kernelTransaction(seedM, "m");
  const p = kernelTransaction(seedP, "p", { kernel: m.kernel, id: m.tx.id });
  return { bundleP: bundleOf(p.kernel, [p.tx]), bundleM: bundleOf(m.kernel, [m.tx]), txP: p.tx, txM: m.tx, kernelM: m.kernel };
}

test("the default factory reports the locked native descriptor and scopes every handle to its store", () => {
  const one = store();
  expect(one.backend.id).toBe(historyBackendId("zixiao:editor-native"));
  expect(one.backend.contractVersion).toBe(1);
  expect(one.backend.algorithm).toBe("fugue-max/sequence-v1");
  expect(one.backend.formats).toEqual({ history: "zixiao-native/history-v1", position: "zixiao-native/position-v1" });
  expect(one.backend.capabilities).toEqual({ selectiveUndo: false, deferredImport: true });
  expect(Object.isFrozen(one.backend.capabilities)).toBe(true);
  expect(one.undo).toBe(undefined);
  assertHistoryBackendCompatibility(one.backend, one.backend, "history");
  expect(() => assertHistoryBackendCompatibility(one.backend, {
    backend: one.backend.id, contractVersion: 1, algorithm: one.backend.algorithm, format: "other/v1",
  }, "history")).toThrow("UNSUPPORTED_FORMAT");
  const initial = registered(one);
  const { writer, head } = open(one, [initial]);
  expect(historyStoreFor(head)).toBe(one);
  const two = store();
  const other = registered(two, "other text");
  const elsewhere = open(two, [other]);
  expect(historyStoreFor(elsewhere.head)).toBe(two);
  expect(() => one.fork({ at: one.revisions([initial]), writer: elsewhere.writer })).toThrow("DIFFERENT_ATOMIC_DOMAIN");
  expect(codeOf(() => one.snapshot(other))).toBe("UNKNOWN_REVISION");
  elsewhere.head.dispose(); elsewhere.writer.dispose(); two.dispose();
  head.dispose(); writer.dispose(); one.dispose();
});

test("documents, heads, history queries and SDK identities work end to end through the facade", async () => {
  const one = store();
  const initial = registered(one);
  expect(registered(one)).toEqual(initial);
  expect(codeOf(() => one.createDocument({ id: document, base: { id: base, text: "other" } }))).toBe("BASE_MISMATCH");
  expect(String(initial.revision).startsWith("hb1:")).toBe(true);
  const { writer, head } = open(one, [initial]);
  const first = commit(head, [edit(head, 1, 1, "😀")]);
  expect(first.status).toBe("committed");
  expect(contents(head)).toBe("A😀B");
  const at = head.checkpoint().revisions.get(document);
  const page = one.history.transactions({ document, includedIn: at, limit: 1 });
  expect(page.items.length).toBe(1);
  const info: TransactionInfo = page.items[0]!;
  expect(String(info.id).startsWith("hb1:")).toBe(true);
  expect(info.actor).toBe(actorId("native:actor"));
  expect(info.document).toBe(document);
  expect(info.after).toBe(at);
  expect(page.next).toBe(null);
  expect(one.history.transaction(first.transactions[0]!).group).toBe(first.groups[0]!);
  expect(one.history.revision(initial).frontier).toEqual([]);
  expect(one.history.revision({ document, revision: at }).parents).toEqual([initial.revision]);
  const isolated = open(one, [initial], "native:other");
  const fork = commit(isolated.head, [edit(isolated.head, 0, 0, "z")]);
  expect(one.history.compare({
    document, left: first.after.revisions.get(document), right: fork.after.revisions.get(document),
  })).toBe("concurrent");
  head.merge({ expect: head.checkpoint(), source: fork.after.revisions });
  expect(contents(head)).toBe("zA😀B");
  const merged = head.checkpoint();
  expect(one.history.compare({
    document, left: first.after.revisions.get(document), right: merged.revisions.get(document),
  })).toBe("ancestor");
  const paged = one.history.transactions({ document, includedIn: merged.revisions.get(document), limit: 1 });
  expect(paged.next).not.toBe(null);
  const rest = one.history.transactions({ document, includedIn: merged.revisions.get(document), limit: 5, cursor: paged.next! });
  expect(rest.items.length).toBe(1);
  expect(codeOf(() => one.history.transactions({ document, includedIn: at, limit: 1, cursor: paged.next! }))).toBe("WRONG_REVISION");
  const snapshot = head.snapshot(document);
  const spans = one.history.provenance({ document, revision: merged.revisions.get(document), range: snapshot.rangeUtf16(0, 1) });
  expect(spans.length).toBe(1);
  expect(spans[0]!.transaction).toBe(fork.transactions[0]!);
  const resolved = one.history.translate({ point: snapshot.pointUtf16(1), to: merged.revisions.get(document), affinity: "after" });
  expect(resolved.status).toBe("present");
  const delivered: CommitReceipt[] = [];
  head.onChange((event) => {
    delivered.push(event.change);
    expect(codeOf(() => commit(head, [], "reentrant"))).toBe("REENTRANT_WRITE");
  });
  const last = commit(head, [edit(head, 0, 0, "q")]);
  expect(delivered.length).toBe(0);
  await flush();
  expect(delivered).toEqual([last]);
  snapshot.dispose();
  isolated.head.dispose(); isolated.writer.dispose();
  head.dispose(); writer.dispose(); one.dispose();
});

test("positions export, encode, import across stores and resolve exactly", () => {
  const one = store();
  const initial = registered(one);
  const { writer, head } = open(one, [initial]);
  const snapshot = head.snapshot(document);
  const onB = snapshot.anchorUtf16(1, { affinity: "after" });
  commit(head, [edit(head, 0, 0, "xy")]);
  const moved = one.history.resolve({ position: onB, at: { document, revision: head.checkpoint().revisions.get(document) } });
  expect(moved.status).toBe("present");
  if (moved.status === "present") expect(moved.point.offset).toBe(3);
  const exported = one.exportPosition({ position: onB });
  const token = decodePositionToken(encodePositionToken(exported.token));
  const two = store();
  const initialTwo = registered(two);
  const imported = two.importPosition(token);
  const resolved = two.history.resolve({ position: imported.position, at: initialTwo });
  expect(resolved.status).toBe("present");
  if (resolved.status === "present") expect(resolved.point.offset).toBe(1);
  // Raw positions are store-local; only exported tokens cross stores.
  expect(codeOf(() => two.history.resolve({ position: onB, at: initialTwo }))).toBe("INVALID_REFERENCE");
  expect(codeOf(() => two.exportPosition({ position: onB }))).toBe("INVALID_REFERENCE");
  const conflict = store();
  registered(conflict, "XY");
  expect(codeOf(() => conflict.importPosition(token))).toBe("BASE_MISMATCH");
  const unregistered = store();
  expect(codeOf(() => unregistered.importPosition(token))).toBe("UNKNOWN_DOCUMENT");
  expect(codeOf(() => two.dispose())).toBe("RESOURCE_IN_USE");
  imported.dispose(); imported.dispose(); exported.dispose(); snapshot.dispose();
  conflict.dispose(); unregistered.dispose(); two.dispose();
  head.dispose(); writer.dispose(); one.dispose();
});

test("deleted guards repair and not-yet-created positions stay distinct", () => {
  const one = store();
  const initial = registered(one);
  const { writer, head } = open(one, [initial]);
  const first = head.snapshot(document);
  const onB = first.anchorUtf16(1, { affinity: "after" });
  first.dispose();
  const insertedX = commit(head, [edit(head, 0, 0, "X")]);
  const second = head.snapshot(document);
  const onX = second.anchorUtf16(0, { affinity: "after" });
  second.dispose();
  commit(head, [edit(head, 2, 3, "")]);
  const atNow = { document, revision: head.checkpoint().revisions.get(document) };
  const deletion = one.history.resolve({ position: onB, at: atNow });
  expect(deletion.status).toBe("deleted");
  if (deletion.status === "deleted") {
    expect(one.history.resolve({ position: deletion.before, at: atNow }).status).toBe("present");
    expect(one.history.resolve({ position: deletion.after, at: atNow }).status).toBe("present");
  }
  expect(one.history.resolve({ position: onX, at: initial }).status).toBe("not-yet-created");
  expect(one.history.resolve({ position: onX, at: { document, revision: insertedX.after.revisions.get(document) } }).status).toBe("present");
  head.dispose(); writer.dispose(); one.dispose();
});

test("history export and import move exact differences without moving heads", () => {
  const sender = store();
  const initial = registered(sender);
  const { head, writer } = open(sender, [initial]);
  const one = commit(head, [edit(head, 0, 0, "X")]);
  const two = commit(head, [edit(head, 1, 1, "Y")]);
  const full = encodeHistoryBundle(sender.exportHistory({ target: two.after.revisions, known: sender.revisions([]) }));
  const delta = encodeHistoryBundle(sender.exportHistory({ target: two.after.revisions, known: one.after.revisions }));
  expect(delta.length).toBeLessThan(full.length);
  const receiver = store();
  const receiverInitial = registered(receiver);
  const receiverHead = open(receiver, [receiverInitial]);
  const before = receiverHead.head.checkpoint();
  const accepted = receiver.importHistory(decodeHistoryBundle(full));
  expect(accepted.status).toBe("accepted");
  if (accepted.status === "pending") throw new Error("unreachable");
  expect(receiverHead.head.checkpoint().stamp).toBe(before.stamp);
  receiverHead.head.merge({ expect: receiverHead.head.checkpoint(), source: accepted.availableRevisions });
  expect(contents(receiverHead.head)).toBe("XYAB");
  expect(receiver.importHistory(decodeHistoryBundle(full)).status).toBe("duplicate");
  const partial = store();
  registered(partial);
  expect(codeOf(() => partial.importHistory(decodeHistoryBundle(delta)))).toBe("MISSING_DEPENDENCIES");
  const wrongBase = store();
  registered(wrongBase, "XY");
  expect(codeOf(() => wrongBase.importHistory(decodeHistoryBundle(full)))).toBe("BASE_MISMATCH");
  const foreign = defineHistoryBackend(backendDouble("native:foreign").definition).createStore();
  const foreignInitial = foreign.createDocument({ id: document, base: { id: base, text: "AB" } });
  const foreignBundle = foreign.exportHistory({ target: foreign.revisions([foreignInitial]), known: foreign.revisions([]) });
  expect(codeOf(() => receiver.importHistory(foreignBundle))).toBe("UNSUPPORTED_FORMAT");
  expect(codeOf(() => encodeHistoryBundle(foreignBundle))).toBe("UNSUPPORTED_FORMAT");
  foreign.dispose();
  receiverHead.head.dispose(); receiverHead.writer.dispose(); receiver.dispose();
  partial.dispose(); wrongBase.dispose();
  head.dispose(); writer.dispose(); sender.dispose();
});

test("deferred imports resolve when missing history arrives, with accepted events", async () => {
  const { bundleP, bundleM } = pendingPair();
  const receiver = store();
  const initial = registered(receiver);
  const { head, writer } = open(receiver, [initial]);
  const before = head.checkpoint();
  const events: { status: string; id: unknown; available?: RevisionSet }[] = [];
  const subscription = receiver.onImport((event) => events.push({
    status: event.status, id: event.id, ...(event.availableRevisions === undefined ? {} : { available: event.availableRevisions }),
  }));
  const pending = receiver.importHistory(bundleP, { missing: "defer" });
  expect(pending.status).toBe("pending");
  if (pending.status !== "pending") throw new Error("unreachable");
  expect(pending.missing.length).toBe(1);
  expect(String(pending.missing[0]).startsWith("hb1:")).toBe(true);
  expect(head.checkpoint().stamp).toBe(before.stamp);
  await flush();
  expect(events.length).toBe(0);
  expect(receiver.importHistory(bundleM).status).toBe("accepted");
  await flush();
  expect(events.length).toBe(1);
  expect(events[0]!.status).toBe("accepted");
  expect(events[0]!.id).toBe(pending.id);
  const snapshot = receiver.snapshot({ document, revision: events[0]!.available!.get(document) });
  expect(snapshot.text()).toBe("pmAB");
  snapshot.dispose();
  expect(receiver.importHistory(bundleP).status).toBe("duplicate");
  expect(head.checkpoint().revisions.get(document)).toBe(before.revisions.get(document));
  subscription.dispose();
  head.dispose(); writer.dispose(); receiver.dispose();
});

test("conflicting payloads for a pending identity reject the batch with a rejected event", async () => {
  const pair = pendingPair();
  const y = kernelTransaction(51, "y");
  expect(y.tx.id).toBe(pair.txP.id);
  expect(y.tx.effects).not.toEqual(pair.txP.effects);
  const bundleQ = bundleOf(pair.kernelM, [pair.txM, y.tx]);
  const receiver = store();
  registered(receiver);
  const events: { status: string; error?: EditorError }[] = [];
  receiver.onImport((event) => events.push({
    status: event.status, ...(event.error === undefined ? {} : { error: event.error }),
  }));
  expect(receiver.importHistory(pair.bundleP, { missing: "defer" }).status).toBe("pending");
  expect(receiver.importHistory(bundleQ).status).toBe("accepted");
  await flush();
  expect(events.length).toBe(1);
  expect(events[0]!.status).toBe("rejected");
  expect(events[0]!.error!.code).toBe("IDENTITY_CONFLICT");
  expect(codeOf(() => receiver.importHistory(pair.bundleP))).toBe("IDENTITY_CONFLICT");
  receiver.dispose();
});

test("identical deferred bundles collapse to one entry and pending storage is bounded", { timeout: 120_000 }, () => {
  const { bundleP } = pendingPair();
  const receiver = store();
  registered(receiver);
  const first = receiver.importHistory(bundleP, { missing: "defer" });
  const again = receiver.importHistory(bundleP, { missing: "defer" });
  expect(first.status).toBe("pending");
  expect(again.status).toBe("pending");
  if (first.status === "pending" && again.status === "pending") expect(again.id).toBe(first.id);
  receiver.dispose();

  // Real ~7 MiB deferred bundles: four fit under the 32 MiB cap, the fifth is refused.
  const text = "a".repeat(95_000);
  const anchor = new NativeHistory({ document, base, text });
  const anchorWriter = new NativeWriter({ actor: actorId("anchor"), replica: replicaId("anchor"), random: { fill(b) { b.fill(78); } } });
  const txAnchor = anchor.prepare({
    at: anchor.initial, writer: anchorWriter, origin: { kind: "remote" },
    edits: [{ range: anchor.source(anchor.initial).snapshot().rangeUtf16(0, 0), text: "s" }],
  })!;
  const big = new NativeHistory({ document, base, text });
  big.accept([txAnchor]);
  const writerBig = new NativeWriter({ actor: actorId("big"), replica: replicaId("big"), random: { fill(b) { b.fill(77); } } });
  const revision = big.revision([txAnchor.id]);
  const bigBundles: HistoryBundle[] = [];
  for (let index = 0; index < 5; index++) {
    const tx = big.prepare({
      at: revision, writer: writerBig, origin: { kind: "remote", label: `big-${index}` },
      edits: [{ range: big.source(revision).snapshot().rangeUtf16(1, 95_001), text: "" }],
    })!;
    bigBundles.push(bundleOf(big, [tx]));
  }
  const bounded = store();
  bounded.createDocument({ id: document, base: { id: base, text } });
  for (let index = 0; index < 4; index++) {
    expect(bounded.importHistory(bigBundles[index]!, { missing: "defer" }).status).toBe("pending");
  }
  expect(codeOf(() => bounded.importHistory(bigBundles[4]!, { missing: "defer" }))).toBe("LIMIT_EXCEEDED");
  bounded.dispose();
  writerBig.dispose(); anchorWriter.dispose();
});

test("pins retain exact revisions and block store disposal until released", () => {
  const one = store();
  const initial = registered(one);
  const { writer, head } = open(one, [initial]);
  const change = commit(head, [edit(head, 0, 0, "X")]);
  const pin = one.pin({ revisions: change.after.revisions });
  expect(pin.revisions.get(document)).toBe(change.after.revisions.get(document));
  expect(Object.isFrozen([...pin.revisions.entries()][0])).toBe(true);
  const unknown = String(change.after.revisions.get(document)).replace(/[0-9a-f]$/u, (c) => c === "0" ? "1" : "0");
  expect(codeOf(() => one.pin({ revisions: one.revisions([{ document, revision: unknown as never }]) })))
    .toBe("UNKNOWN_REVISION");
  head.dispose(); writer.dispose();
  expect(codeOf(() => one.dispose())).toBe("RESOURCE_IN_USE");
  pin.dispose();
  pin.dispose();
  one.dispose();
  expect(codeOf(() => one.revisions([]))).toBe("DISPOSED");
});

test("import subscriptions normalize delivery, contain listener faults and reject reentrancy", async () => {
  const { bundleP, bundleM } = pendingPair();
  const errors: EditorError[] = [];
  const receiver = store({ onError: (error) => errors.push(error) });
  registered(receiver);
  const seen: unknown[] = [];
  const faulty = receiver.onImport((event) => {
    seen.push(event);
    expect(Object.isFrozen(event)).toBe(true);
    expect(codeOf(() => receiver.openWriter({ actor: actorId("late"), replica: replicaId("late") }))).toBe("REENTRANT_WRITE");
    throw new Error("listener failure");
  });
  const quiet: unknown[] = [];
  const cancelled = receiver.onImport((event) => quiet.push(event));
  expect(receiver.importHistory(bundleP, { missing: "defer" }).status).toBe("pending");
  expect(receiver.importHistory(bundleM).status).toBe("accepted");
  cancelled.dispose();
  await flush();
  expect(seen.length).toBe(1);
  expect(quiet.length).toBe(0);
  expect(errors.length).toBe(1);
  expect(errors[0]!.cause).toBeInstanceOf(Error);
  faulty.dispose();
  faulty.dispose();
  cancelled.dispose();
  receiver.dispose();
});

test("capture-once and foreign-handle rejection hold through the public facade", () => {
  const one = store();
  const two = store();
  const oneInitial = registered(one);
  const twoInitial = registered(two);
  const oneHead = open(one, [oneInitial]);
  const twoHead = open(two, [twoInitial]);
  const twoSnapshot = twoHead.head.snapshot(document);
  const twoExport = two.exportPosition({ position: twoSnapshot.anchorUtf16(0, { affinity: "before" }) });
  const carried = one.importPosition(twoExport.token);
  expect(one.history.resolve({ position: carried.position, at: oneInitial }).status).toBe("present");
  expect(codeOf(() => oneHead.head.merge({ expect: twoHead.head.checkpoint(), source: twoHead.head.checkpoint().revisions })))
    .toBe("STALE_CHECKPOINT");
  let reads = 0;
  const entry = { document, get revision() { reads++; return oneInitial.revision; } };
  expect(one.revisions([entry]).get(document)).toBe(oneInitial.revision);
  expect(reads).toBe(1);
  carried.dispose(); twoExport.dispose(); twoSnapshot.dispose();
  twoHead.head.dispose(); twoHead.writer.dispose(); two.dispose();
  oneHead.head.dispose(); oneHead.writer.dispose(); one.dispose();
});
