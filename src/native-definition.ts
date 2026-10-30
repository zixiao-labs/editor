import { captureDescriptor, makeContext, type BackendContextState } from "./backends/context.js";
import type { HistoryBackendDescriptor } from "./contracts/history-backend.js";
import { historyBackendId } from "./identity.js";

/**
 * Locked protocol identity of the default FugueMax backend. The format IDs are
 * versioned codec contracts: peers claiming this family/algorithm can exchange
 * history bundles and position tokens through the exported codec functions.
 */
export const nativeDescriptor: HistoryBackendDescriptor = Object.freeze({
  id: historyBackendId("zixiao:editor-native"),
  contractVersion: 1 as const,
  algorithm: "fugue-max/sequence-v1",
  formats: Object.freeze({ history: "zixiao-native/history-v1", position: "zixiao-native/position-v1" }),
  capabilities: Object.freeze({ selectiveUndo: false, deferredImport: true }),
});

/**
 * Shared adapter context for the native protocol: portable position tokens and
 * history bundles created through this context are readable by every store of
 * the same protocol family, independent of which store issued them.
 */
export const nativeContextState: BackendContextState = makeContext(captureDescriptor(nativeDescriptor));
