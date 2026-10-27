import {
  documentId, EditorError,
  type CancellationSignal, type CoreFactories, type SessionCommitReceipt, type DiffInput,
} from "@zixiao-labs/editor";

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
void [error, signal, api, diff];
