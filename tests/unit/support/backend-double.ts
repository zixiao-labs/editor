import type {
  CommitReceipt, EditingHead, HeadChangeEvent, HeadCheckpoint, HistoryImportEvent, RevisionEntry, RevisionSet,
  TextSnapshot,
} from "../../../src/contracts/core.js";
import type {
  HistoryBackendContext, HistoryBackendDefinition, HistoryBackendDescriptor, HistoryStoreImplementation,
} from "../../../src/contracts/history-backend.js";
import { EditorError } from "../../../src/errors.js";
import { externalBaseId, historyBackendId, historyPendingId, type DocumentId } from "../../../src/identity.js";

/**
 * Scripted port double, NOT an alternative CRDT or a backend-conformance claim.
 * Every method is deliberately observable; only the scenarios in gateway tests
 * are scripted. No production module imports this.
 */
export function backendDouble(name = "fixture:one", undo = false, deferred = false): {
  definition: HistoryBackendDefinition; calls: Map<string, number>;
  contexts: HistoryBackendContext[]; rawHeads: EditingHead[];
  emitImport(event: HistoryImportEvent): void;
} {
  const calls = new Map<string, number>();
  const contexts: HistoryBackendContext[] = [];
  const rawHeads: EditingHead[] = [];
  const importListeners = new Set<(event: HistoryImportEvent) => void>();
  const tap = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const descriptor: HistoryBackendDescriptor = {
    id: historyBackendId(name), contractVersion: 1, algorithm: "scripted-dispatch/v1",
    formats: { history: "fixture-bundle/v1", position: "fixture-position/v1" },
    capabilities: { selectiveUndo: undo, deferredImport: deferred },
  };
  const definition: HistoryBackendDefinition = {
    descriptor,
    createStore(context): HistoryStoreImplementation {
      contexts.push(context); tap("createStore");
      const ids = context.identities;
      const positions = context.positions<{ offset: number }>();
      const tokens = context.positionTokens<{ offset: number }>();
      const bundles = context.bundles<{ entries: readonly RevisionEntry[] }>();
      const docs = new Map<DocumentId, { text: string; revision: RevisionEntry["revision"] }>();
      let serial = 0;
      const set = (entries: readonly RevisionEntry[]): RevisionSet => {
        const captured = entries.map((entry) => Object.freeze({ ...entry }));
        return Object.freeze({
          get(document: DocumentId) {
            const value = captured.find((entry) => entry.document === document);
            if (!value) throw new EditorError("UNKNOWN_DOCUMENT", "UNKNOWN_DOCUMENT: fixture document");
            return value.revision;
          },
          has: (document: DocumentId) => captured.some((entry) => entry.document === document),
          entries: () => captured.values(),
        });
      };
      const snapshot = (entry: RevisionEntry): TextSnapshot => {
        tap("snapshot"); const text = docs.get(entry.document)!.text;
        const point = (offset: number, unit: "utf16" | "utf8" | "scalar") => Object.freeze({ ...entry, offset, unit });
        return Object.freeze({
          ...entry, lengthUtf16: text.length, text: () => text,
          readUtf16: (start, end) => text.slice(start, end),
          pointUtf16: (offset) => point(offset, "utf16"), pointUtf8: (offset) => point(offset, "utf8"),
          pointScalar: (offset) => point(offset, "scalar"), convertPoint: (input, unit) => point(input.offset, unit),
          rangeUtf16: (start, end) => Object.freeze({ ...entry, start, end, unit: "utf16" }),
          anchorUtf16: (offset) => positions.create({ offset }),
          stableRangeUtf16: (start, end) => Object.freeze({ start: positions.create({ offset: start }), end: positions.create({ offset: end }) }),
          dispose: () => { tap("snapshot.dispose"); },
        } satisfies TextSnapshot);
      };
      const receipt = (checkpoint: HeadCheckpoint, after = checkpoint): CommitReceipt => context.issueReceipt({
        id: ids.create("commit", String(++serial)), before: checkpoint, after,
        documents: [], transactions: [], groups: [], status: "no-change",
      });
      const store: HistoryStoreImplementation = {
        createDocument(input) {
          tap("createDocument");
          const revision = ids.create("revision", "root:" + input.id);
          docs.set(input.id, { text: input.base.text, revision });
          return Object.freeze({ document: input.id, revision });
        },
        openWriter(input) { tap("openWriter"); return Object.freeze({ ...input, dispose: () => { tap("writer.dispose"); } }); },
        revisions(input) { tap("revisions"); return set(input); },
        fork(input) {
          tap("fork");
          let checkpoint: HeadCheckpoint = Object.freeze({
            headId: ids.create("head", String(++serial)), stamp: ids.create("stamp", "0"), revisions: set([...input.at.entries()]),
          });
          const listeners = new Set<(event: HeadChangeEvent) => void>();
          const head: EditingHead = {
            checkpoint: () => checkpoint,
            snapshot: (document) => snapshot({ document, revision: checkpoint.revisions.get(document) }),
            document: (document) => ({ head, document }),
            commit(command) {
              tap("commit");
              if (command.edits.length) throw new Error("unscripted fixture edit");
              return receipt(checkpoint);
            },
            merge() { tap("merge"); return receipt(checkpoint); },
            checkout(command) {
              tap("checkout"); const before = checkpoint;
              checkpoint = Object.freeze({ ...checkpoint, stamp: ids.create("stamp", String(++serial)), revisions: command.at });
              const change = receipt(before, checkpoint);
              // Deliberately synchronous: the gateway must normalize delivery.
              for (const listener of listeners) listener({ change, reason: "checkout", origin: { kind: "fixture" } });
              return change;
            },
            onChange(listener) { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
            dispose() { tap("head.dispose"); listeners.clear(); },
          };
          rawHeads.push(head); return Object.freeze(head);
        },
        snapshot,
        pin(input) { tap("pin"); return Object.freeze({ revisions: input.revisions, dispose: () => { tap("pin.dispose"); } }); },
        exportPosition(input) {
          tap("exportPosition");
          return Object.freeze({ position: input.position, token: tokens.create(positions.read(input.position)), dispose() { tap("position.dispose"); } });
        },
        importPosition(token) {
          tap("importPosition"); const value = tokens.read(token);
          return Object.freeze({ position: positions.create(value), token, dispose() { tap("position.dispose"); } });
        },
        exportHistory(input) { tap("exportHistory"); return bundles.create({ entries: [...input.target.entries()] }); },
        importHistory(bundle, options) {
          tap("importHistory"); const value = bundles.read(bundle);
          return options?.missing === "defer"
            ? { status: "pending", missing: [ids.create("transaction", "missing")], id: historyPendingId(`fixture-pending:${++serial}`) }
            : { status: "duplicate", availableRevisions: set(value.entries) };
        },
        onImport(listener) {
          tap("onImport"); importListeners.add(listener);
          return { dispose: () => { tap("import.dispose"); importListeners.delete(listener); } };
        },
        history: {
          revision(input) { tap("revision"); return { ...input, base: externalBaseId("fixture"), frontier: [], parents: [] }; },
          transaction() { throw new Error("unscripted fixture transaction"); },
          transactions() { tap("transactions"); return { items: [], next: null }; },
          compare() { tap("compare"); return "equal"; },
          provenance() { tap("provenance"); return []; },
          resolve(input) { tap("resolve"); return { status: "present", point: { ...input.at, unit: "utf16", offset: positions.read(input.position).offset } }; },
          translate(input) { tap("translate"); return { status: "present", point: { ...input.point, revision: input.to } }; },
        },
        async diff(input) {
          tap("diff");
          return {
            schemaVersion: 1, basis: input.change ? "commit" : "versions",
            from: input.change ? input.change.before.revisions : input.from!,
            to: input.change ? input.change.after.revisions : input.to!,
            transactions: [], documents: [], maxOutputBytes: 128,
          };
        },
        dispose() { tap("store.dispose"); },
      };
      if (undo) Object.assign(store, {
        undo: {
          open(input: { head: EditingHead }) {
            tap("undo.open");
            if (!rawHeads.includes(input.head)) throw new Error("wrapper did not unwrap its head");
            const effects = context.undoTokens<CommitReceipt>();
            return {
              capture(input: { change: CommitReceipt }) { tap("undo.capture"); return effects.create(input.change); },
              apply() { tap("undo.apply"); return { status: "no-effect", change: receipt(input.head.checkpoint()) }; },
              dispose() { tap("undo.dispose"); },
            };
          },
        },
      });
      return store;
    },
  };
  return {
    definition, calls, contexts, rawHeads,
    emitImport(event) { for (const listener of [...importListeners]) listener(event); },
  };
}
