import {
  documentId, EditorError,
  type CancellationSignal, type CoreFactories, type SessionCommitReceipt, type DiffInput,
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
// @ts-expect-error The headless fixture must never accidentally acquire a DOM library.
type NoDom = HTMLCanvasElement;
// @ts-expect-error Type-only contracts must not advertise callable runtime exports.
import { createHistoryStore } from "@zixiao-labs/editor";
// @ts-expect-error Optional integration factories are not implemented yet.
import { connectLanguageServer } from "@zixiao-labs/editor/lsp";
void [
  error, signal, api, diff, collaboration, languages, lsp, shaping, syntax, binding, layout,
  createHistoryStore, connectLanguageServer,
];
