import { expectTypeOf } from "@lightning-js/lightning";
import {
  defineHistoryBackend, historyBackendId, historyStoreFor,
  type HistoryBackend, type HistoryBackendContext, type HistoryStore, type HistoryStoreImplementation,
  type HistoryBackendId, type DocumentId, type RevisionId, type StablePosition, type HistoryBundle,
  type EditingHead, type HistoryUndoToken, type HistoryBackendProtocol,
  type HistoryCommitData, type SelectionRestoreResult, type SessionCommitReceipt,
} from "../../src/index.js";
import type { HistoryOfferDescriptor } from "../../src/contracts/collaboration.js";
import { NativeStore } from "../../src/history/native-store.js";

declare const product: HistoryStoreImplementation;
declare const head: EditingHead;
declare const context: HistoryBackendContext;
expectTypeOf<HistoryBackendId>().not.toEqualTypeOf<DocumentId>();
expectTypeOf<HistoryOfferDescriptor>().toExtend<HistoryBackendProtocol>();
expectTypeOf(historyStoreFor(head)).toEqualTypeOf<HistoryStore>();
const backend = defineHistoryBackend({
  descriptor: {
    id: historyBackendId("product:custom"), contractVersion: 1, algorithm: "product-order/v1",
    formats: { history: "product-wire/v1", position: "product-position/v1" },
    capabilities: { selectiveUndo: false, deferredImport: true },
  },
  createStore(_context, _options) { return product; },
});
expectTypeOf(backend).toEqualTypeOf<HistoryBackend>();
expectTypeOf(backend.createStore()).toEqualTypeOf<HistoryStore>();
const revision = context.identities.create("revision", "custom");
expectTypeOf(revision).toEqualTypeOf<RevisionId>();
// @ts-expect-error Backend identity categories cannot be mixed.
context.identities.local("transaction", revision);
const positions = context.positions<{ readonly guard: string }>();
const position = positions.create({ guard: "node" });
expectTypeOf(position).toEqualTypeOf<StablePosition>();
const bundle = context.bundles<string>().create("encoded payload");
expectTypeOf(bundle).toEqualTypeOf<HistoryBundle>();
declare const receiptData: HistoryCommitData;
declare const selectionEffects: SelectionRestoreResult;
const sessionReceipt = context.issueReceipt({ ...receiptData, selectionEffects });
expectTypeOf(sessionReceipt).toExtend<SessionCommitReceipt>();
// @ts-expect-error Extending a receipt must not make core arrays mutable.
sessionReceipt.transactions.push(context.identities.create("transaction", "forged"));
// @ts-expect-error Opaque values are not interchangeable.
positions.read(bundle);
// @ts-expect-error Undo tokens are not positions.
const undo: HistoryUndoToken = position;
// @ts-expect-error Consumer code cannot forge a position.
const forged: StablePosition = {};
defineHistoryBackend({
  descriptor: backend.descriptor,
  createStore(): HistoryStoreImplementation {
    // @ts-expect-error NativeStore is still incomplete: codec/pin/Diff are not implemented.
    return new NativeStore();
  },
});
// @ts-expect-error Metadata is immutable to callers.
backend.descriptor.formats.history = "other";
void [head, undo, forged];
