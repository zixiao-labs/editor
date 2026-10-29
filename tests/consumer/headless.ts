import {
  documentId, EditorError, defineHistoryBackend, historyBackendId, historyStoreFor,
  createTextSource,
  type CancellationSignal, type CoreFactories, type SessionCommitReceipt, type DiffInput,
  type HistoryStoreImplementation,
} from "@zixiao-labs/editor";
import type { CollaborationFactories } from "@zixiao-labs/editor/collaboration";
import type { LanguageFactories, SyntaxService } from "@zixiao-labs/editor/languages";
import type { LspFactories, LanguageBinding } from "@zixiao-labs/editor/lsp";
import type { ShapingFactories, LayoutEngine } from "@zixiao-labs/editor/shaping";

// Checked with ES2022 only, NO DOM and NO ambient Node types.
const id = documentId("consumer");
const error = new EditorError("UNKNOWN_DOCUMENT", `Unknown ${id}`);
const signal: CancellationSignal = {
  aborted: false,
  addEventListener(_type, _listener) {},
  removeEventListener(_type, _listener) {},
};
declare const api: CoreFactories;
declare const change: SessionCommitReceipt;
const diff: DiffInput = { change };
declare const collaboration: CollaborationFactories;
declare const languages: LanguageFactories;
declare const lsp: LspFactories;
declare const shaping: ShapingFactories;
declare const syntax: SyntaxService;
declare const binding: LanguageBinding;
declare const layout: LayoutEngine;
declare const productBackend: HistoryStoreImplementation;
const backend = defineHistoryBackend({
  descriptor: {
    id: historyBackendId("consumer:backend"), contractVersion: 1, algorithm: "product-order/v1",
    formats: { history: "product-history/v1", position: "product-position/v1" },
    capabilities: { selectiveUndo: false, deferredImport: false },
  },
  createStore() { return productBackend; },
});
// A product-owned read buffer needs neither a HistoryStore nor history identities.
const text = createTextSource({
  snapshot: () => ({ kind: "snapshot", lengthUtf16: 2, readUtf16: (a, b) => "AB".slice(a, b), dispose() {} }),
  onChange: () => ({ dispose() {} }),
});
const read = text.snapshot();
read.read(read.rangeUtf16(0, 1));
read.dispose(); text.dispose();
// @ts-expect-error The headless fixture must never accidentally acquire a DOM library.
type NoDom = HTMLCanvasElement;
// @ts-expect-error Type-only contracts must not advertise callable runtime exports.
import { createHistoryStore } from "@zixiao-labs/editor";
// @ts-expect-error Optional integration factories are not implemented yet.
import { connectLanguageServer } from "@zixiao-labs/editor/lsp";
void [
  error, signal, api, diff, collaboration, languages, lsp, shaping, syntax, binding, layout,
  createHistoryStore, connectLanguageServer,
  backend, historyStoreFor,
];
