import { expect, test } from "@lightning-js/lightning";
import { defineHistoryBackend, assertHistoryBackendCompatibility, historyStoreFor } from "../../src/index.js";
import { actorId, documentId, externalBaseId, historyBackendId, replicaId } from "../../src/identity.js";
import type { HistoryBackendDescriptor, HistoryBackendContext } from "../../src/contracts/history-backend.js";
import type { HistoryStore } from "../../src/contracts/core.js";
import { backendDouble } from "./support/backend-double.js";

function descriptor(id = "test:one"): HistoryBackendDescriptor {
  return {
    id: historyBackendId(id), contractVersion: 1, algorithm: "test-order/v1",
    formats: { history: "test-history/v1", position: "test-position/v1" },
    capabilities: { selectiveUndo: false, deferredImport: false },
  };
}

test("backend definitions snapshot metadata and refuse partial stores rather than exporting fake factories", () => {
  const metadata = descriptor();
  const provider = {
    marker: "provider receiver",
    descriptor: metadata,
    createStore() { expect(this.marker).toBe("provider receiver"); return {} as HistoryStore; },
  };
  const backend = defineHistoryBackend(provider);
  Object.assign(metadata.formats, { history: "mutated" });
  expect(backend.descriptor.formats.history).toBe("test-history/v1");
  expect(Object.isFrozen(backend.descriptor.capabilities)).toBe(true);
  expect(() => backend.createStore()).toThrow("complete HistoryStore");
  expect(() => defineHistoryBackend({
    descriptor: { ...metadata, contractVersion: 2 as 1 }, createStore() { return {} as HistoryStore; },
  })).toThrow("UNSUPPORTED_FORMAT");
});

test("backend namespaces separate IDs, local positions and portable format-specific values", () => {
  const contexts: HistoryBackendContext[] = [];
  for (const id of ["test:one", "test:two"]) {
    const backend = defineHistoryBackend({
      descriptor: descriptor(id), createStore(context) { contexts.push(context); return {} as HistoryStore; },
    });
    expect(() => backend.createStore()).toThrow("complete HistoryStore");
  }
  const [one, two] = contexts;
  const a = one!.identities.create("revision", "same:😀");
  const b = two!.identities.create("revision", "same:😀");
  expect(a).not.toBe(b);
  expect(one!.identities.local("revision", a)).toBe("same:😀");
  expect(() => one!.identities.local("revision", b)).toThrow("DIFFERENT_ATOMIC_DOMAIN");
  const guards = one!.positions<{ guard: string }>();
  const position = guards.create({ guard: "node" });
  expect(guards.read(position)).toEqual({ guard: "node" });
  expect(guards.has({ ...position })).toBe(false);
  expect(() => two!.positions().read(position)).toThrow("INVALID_REFERENCE");
  const bundle = one!.bundles<string>().create("encoded payload");
  expect(one!.bundles<string>().read(bundle)).toBe("encoded payload");
  expect(() => two!.bundles<string>().read(bundle)).toThrow("UNSUPPORTED_FORMAT");
});

test("wire compatibility is explicit and does not equate equal algorithm labels with equal backends or formats", () => {
  const one = descriptor();
  expect(() => assertHistoryBackendCompatibility(one, descriptor("test:other"), "history")).toThrow("UNSUPPORTED_FORMAT");
  const otherFormat = { ...one, formats: { ...one.formats, history: "test-history/v2" } };
  expect(() => assertHistoryBackendCompatibility(one, otherFormat, "history")).toThrow("UNSUPPORTED_FORMAT");
  assertHistoryBackendCompatibility(one, otherFormat, "position");
  assertHistoryBackendCompatibility(one, descriptor(), "history");
  assertHistoryBackendCompatibility(one, {
    backend: one.id, contractVersion: 1, algorithm: one.algorithm, format: one.formats.history,
  }, "history");
});

function opened(name = "fixture:one", undo = false, defer = false) {
  const fixture = backendDouble(name, undo, defer);
  const store = defineHistoryBackend(fixture.definition).createStore();
  const document = documentId("same-document");
  const initial = store.createDocument({ id: document, base: { id: externalBaseId("same-base"), text: "AB" } });
  const revisions = store.revisions([initial]);
  const writer = store.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = store.fork({ at: revisions, writer });
  const dispose = () => { head.dispose(); writer.dispose(); store.dispose(); };
  return { ...fixture, store, document, initial, revisions, writer, head, dispose };
}

test("two product providers route through the same gateway without loading native history internals", async () => {
  for (const name of ["fixture:one", "fixture:two"]) {
    const one = opened(name);
    const snapshot = one.head.snapshot(one.document);
    expect(snapshot.text()).toBe("AB");
    expect(one.head.document(one.document).head).toBe(one.head);
    expect(historyStoreFor(one.head)).toBe(one.store);
    const position = snapshot.anchorUtf16(1, { affinity: "after" });
    expect(one.store.history.resolve({ position, at: one.initial }).status).toBe("present");
    const change = one.head.commit({ expect: one.head.checkpoint(), origin: { kind: "test" }, edits: [] });
    const diff = await one.store.diff({ change });
    expect(diff.basis).toBe("commit");
    const decorated = one.contexts[0]!.issueReceipt({ ...change, productNote: "backend-owned extension" });
    expect(decorated.productNote).toBe("backend-owned extension");
    expect((await one.store.diff({ change: decorated })).basis).toBe("commit");
    expect(one.calls.get("commit")).toBe(1);
    expect(one.calls.get("diff")).toBe(2);
    expect(one.store.backend.id).toBe(historyBackendId(name));
    snapshot.dispose(); one.dispose();
  }
});

test("foreign IDs, handles, positions, bundles and receipts reject before invoking a product backend", async () => {
  const one = opened(), two = opened("fixture:two");
  const before = new Map(one.calls);
  const otherSnapshot = two.head.snapshot(two.document);
  const foreign = otherSnapshot.anchorUtf16(0, { affinity: "before" });
  const foreignBundle = two.store.exportHistory({ target: two.revisions, known: two.store.revisions([]) });
  const foreignReceipt = two.head.commit({ expect: two.head.checkpoint(), origin: { kind: "test" }, edits: [] });
  for (const action of [
    () => one.store.snapshot(two.initial),
    () => one.store.revisions([two.initial]),
    () => one.head.merge({ expect: one.head.checkpoint(), source: two.revisions }),
    () => one.head.commit({ expect: one.head.checkpoint(), origin: { kind: "foreign" },
      edits: [{ document: one.document, range: otherSnapshot.rangeUtf16(0, 1), text: "" }] }),
    () => one.store.history.compare({ document: one.document, left: one.initial.revision, right: two.initial.revision }),
    () => one.store.fork({ at: one.revisions, writer: two.writer }),
  ]) expect(action).toThrow("DIFFERENT_ATOMIC_DOMAIN");
  expect(() => one.store.history.resolve({ position: foreign, at: one.initial })).toThrow("INVALID_REFERENCE");
  expect(() => one.store.importHistory(foreignBundle)).toThrow("UNSUPPORTED_FORMAT");
  let failed = false;
  try { await one.store.diff({ change: foreignReceipt }); } catch { failed = true; }
  expect(failed).toBe(true);
  expect(one.calls).toEqual(before);
  otherSnapshot.dispose(); one.dispose(); two.dispose();
});

test("compatible formats transfer portable tokens, while local values and unsupported features remain scoped", () => {
  const one = opened(), two = opened();
  const snapshot = one.head.snapshot(one.document);
  const position = snapshot.anchorUtf16(1, { affinity: "before" });
  expect(() => two.store.history.resolve({ position, at: two.initial })).toThrow("INVALID_REFERENCE");
  const exported = one.store.exportPosition({ position });
  const imported = two.store.importPosition(exported.token);
  expect(two.store.history.resolve({ position: imported.position, at: two.initial }).status).toBe("present");
  const bundle = one.store.exportHistory({ target: one.revisions, known: one.store.revisions([]) });
  expect(two.store.importHistory(bundle).status).toBe("duplicate");
  const imports = two.calls.get("importHistory");
  expect(() => two.store.importHistory(bundle, { missing: "defer" })).toThrow("UNSUPPORTED_CAPABILITY");
  expect(two.calls.get("importHistory")).toBe(imports);
  expect(two.store.undo).toBe(undefined);
  imported.dispose(); exported.dispose(); snapshot.dispose(); one.dispose(); two.dispose();
});

test("selective undo is a delegated effects port with head/scope ownership and no prescribed register algorithm", () => {
  const one = opened("fixture:undo", true);
  const change = one.head.commit({ expect: one.head.checkpoint(), origin: { kind: "test" }, edits: [] });
  const scope = one.store.undo!.open({ head: one.head });
  const second = one.store.undo!.open({ head: one.head });
  const token = scope.capture({ change });
  expect(() => second.apply({ expect: one.head.checkpoint(), tokens: [token], direction: "undo" })).toThrow("INVALID_REFERENCE");
  const result = scope.apply({ expect: one.head.checkpoint(), tokens: [token], direction: "redo" });
  expect(result.status).toBe("no-effect");
  expect(one.calls.get("undo.apply")).toBe(1);
  expect(() => one.head.dispose()).toThrow("RESOURCE_IN_USE");
  scope.dispose(); second.dispose();
  expect(() => scope.capture({ change })).toThrow("DISPOSED");
  one.dispose();
});

test("gateway owns handle lifetimes and normalizes notifications without cascading disposal or reentrant writes", async () => {
  const one = opened();
  const snapshot = one.head.snapshot(one.document);
  const pin = one.store.pin({ revisions: one.revisions });
  const events: unknown[] = [];
  one.head.onChange((event) => {
    events.push(event);
    expect(() => one.head.commit({ expect: one.head.checkpoint(), origin: { kind: "reentrant" }, edits: [] })).toThrow("REENTRANT_WRITE");
  });
  one.head.checkout({ expect: one.head.checkpoint(), at: one.revisions });
  expect(events).toEqual([]);
  await Promise.resolve();
  expect(events.length).toBe(1);
  expect(() => one.writer.dispose()).toThrow("RESOURCE_IN_USE");
  one.head.dispose(); one.writer.dispose();
  expect(() => one.store.dispose()).toThrow("RESOURCE_IN_USE");
  snapshot.dispose(); snapshot.dispose(); pin.dispose(); one.store.dispose(); one.store.dispose();
  expect(one.calls.get("snapshot.dispose")).toBe(1);
  expect(one.calls.get("store.dispose")).toBe(1);
  expect(() => one.store.revisions([])).toThrow("DISPOSED");
  expect(() => historyStoreFor(one.head)).toThrow("DISPOSED");
});

test("capabilities are checked before routing, complete stores cannot be reopened, and defer is optional", () => {
  const fixture = backendDouble("fixture:reused");
  let saved: ReturnType<typeof fixture.definition.createStore> | undefined;
  const backend = defineHistoryBackend({
    descriptor: fixture.definition.descriptor,
    createStore(context, options) { return saved ??= fixture.definition.createStore(context, options); },
  });
  const store = backend.createStore();
  expect(() => backend.createStore()).toThrow("fresh store");
  store.dispose();
  const missingUndo = backendDouble("fixture:missing-undo");
  expect(() => defineHistoryBackend({
    ...missingUndo.definition,
    descriptor: { ...missingUndo.definition.descriptor, capabilities: { selectiveUndo: true, deferredImport: false } },
  }).createStore()).toThrow("HistoryUndoProvider");
  const one = opened("fixture:defer", false, true);
  const bundle = one.store.exportHistory({ target: one.revisions, known: one.store.revisions([]) });
  const pending = one.store.importHistory(bundle, { missing: "defer" });
  expect(pending.status).toBe("pending");
  if (pending.status === "pending") expect(one.contexts[0]!.identities.local("transaction", pending.missing[0]!)).toBe("missing");
  one.dispose();
});

test("revision and query inputs are captured once before namespace validation and backend dispatch", () => {
  const one = opened(), two = opened("fixture:two");
  let reads = 0;
  const supplied = {
    document: one.document, get revision() { reads++; return reads === 1 ? one.initial.revision : two.initial.revision; },
  };
  expect(one.store.revisions([supplied]).get(one.document)).toBe(one.initial.revision);
  expect(reads).toBe(1);
  reads = 0;
  const query = {
    document: one.document, get includedIn() { reads++; return reads === 1 ? one.initial.revision : two.initial.revision; }, limit: 1,
  };
  one.store.history.transactions(query);
  expect(reads).toBe(1);
  one.dispose(); two.dispose();
});

test("an asynchronous backend Diff borrows the store until completion", async () => {
  const one = opened();
  const pending = one.store.diff({ from: one.revisions, to: one.revisions });
  one.head.dispose(); one.writer.dispose();
  expect(() => one.store.dispose()).toThrow("RESOURCE_IN_USE");
  expect((await pending).basis).toBe("versions");
  one.store.dispose();
});
