import { captureDescriptor, captureProtocol, makeContext, type BackendContextState } from "./backends/context.js";
import type {
  CommitReceipt, Disposable, EditingHead, HeadChangeEvent, HeadCheckpoint, HistoryImportEvent, HistoryImportReport,
  HistoryQueries, HistoryStore, HistoryStoreOptions, PositionResolution, RevisionEntry, TextPoint, TextRange,
  TextSnapshot, Writer,
} from "./contracts/core.js";
import type {
  HistoryBackend, HistoryBackendDefinition, HistoryBackendDescriptor, HistoryUndoScope, HistoryUndoToken,
  HistoryStoreImplementation, HistoryBackendProtocol,
} from "./contracts/history-backend.js";
import { EditorError } from "./errors.js";
import { historyPendingId } from "./identity.js";

const implementations = new WeakSet<object>();
const headOwners = new WeakMap<EditingHead, Readonly<{ store: HistoryStore; active: () => void }>>();

/** Upper layers use this association, never instanceof a native head or a global selected backend. */
export function historyStoreFor(head: EditingHead): HistoryStore {
  const owner = headOwners.get(head);
  if (!owner) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: head was not opened by a history backend");
  owner.active();
  return owner.store;
}

/** Compatibility is an exact protocol check, not an algorithm-label heuristic or migration. */
export function assertHistoryBackendCompatibility(
  local: HistoryBackendDescriptor, remote: HistoryBackendDescriptor | HistoryBackendProtocol, format: "history" | "position",
): void {
  const a = captureDescriptor(local);
  if (format !== "history" && format !== "position") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown protocol kind");
  const b = "formats" in remote ? (() => {
    const descriptor = captureDescriptor(remote);
    return { backend: descriptor.id, contractVersion: descriptor.contractVersion, algorithm: descriptor.algorithm, format: descriptor.formats[format] };
  })() : captureProtocol(remote);
  if (a.id !== b.backend || a.algorithm !== b.algorithm ||
    a.contractVersion !== b.contractVersion || a.formats[format] !== b.format) {
    throw new EditorError("UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT: incompatible history backend protocol");
  }
}

function methods(value: unknown, names: readonly string[], label: string): void {
  if (!value || (typeof value !== "object" && typeof value !== "function") ||
    names.some((name) => typeof (value as Record<string, unknown>)[name] !== "function")) {
    throw new EditorError("UNSUPPORTED_CAPABILITY", `UNSUPPORTED_CAPABILITY: backend must provide a complete ${label}`);
  }
}

/** Open only complete product implementations. No native default, algorithm switch or global registry. */
export function defineHistoryBackend(definition: HistoryBackendDefinition): HistoryBackend {
  if (!definition || typeof definition !== "object") {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: backend definition is required");
  }
  const descriptor = captureDescriptor(definition.descriptor);
  const create = definition.createStore;
  if (typeof create !== "function") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: backend factory is required");
  return Object.freeze({
    descriptor,
    createStore(options: HistoryStoreOptions = {}): HistoryStore {
      const context = makeContext(descriptor);
      const captured = Object.freeze({ ...options });
      const implementation = create.call(definition, context.api, captured);
      methods(implementation, ["createDocument", "openWriter", "revisions", "fork", "snapshot", "pin", "exportPosition",
        "importPosition", "exportHistory", "importHistory", "onImport", "diff", "dispose"], "HistoryStore");
      methods(implementation.history, ["revision", "transaction", "transactions", "compare", "provenance", "resolve", "translate"], "HistoryQueries");
      if (descriptor.capabilities.selectiveUndo) methods(implementation.undo, ["open"], "HistoryUndoProvider");
      else if (implementation.undo !== undefined) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: undo port contradicts backend capabilities");
      }
      if (implementations.has(implementation)) {
        throw new EditorError("DIFFERENT_ATOMIC_DOMAIN", "DIFFERENT_ATOMIC_DOMAIN: a backend factory must return a fresh store");
      }
      implementations.add(implementation);
      const store = connect(implementation, context, captured);
      implementations.add(store);
      return store;
    },
  });
}

interface Lease { active(): void; dispose(): void }
interface WriterState { readonly raw: Writer; readonly lease: Lease; heads: number }
interface HeadState { readonly raw: EditingHead; readonly lease: Lease; undo: number }

function connect(raw: HistoryStoreImplementation,
  context: BackendContextState, options: HistoryStoreOptions): HistoryStore {
  const { descriptor, identities: ids } = context.api;
  const writers = new WeakMap<Writer, WriterState>();
  const heads = new WeakMap<EditingHead, HeadState>();
  let disposed = false, writing = false, notifying = false, resources = 0;
  const active = (): void => { if (disposed) throw new EditorError("DISPOSED", "DISPOSED: backend store has been released"); };
  const write = <T>(action: () => T): T => {
    active();
    if (writing || notifying) throw new EditorError("REENTRANT_WRITE", "REENTRANT_WRITE: schedule writes after notification");
    writing = true;
    try { return action(); } finally { writing = false; }
  };
  const lease = (handle: Disposable, released: () => void = () => {}): Lease => {
    let alive = true;
    resources++;
    return {
      active(): void { active(); if (!alive) throw new EditorError("DISPOSED", "DISPOSED: backend handle has been released"); },
      dispose(): void {
        if (!alive) return;
        write(() => { handle.dispose(); alive = false; resources--; released(); });
      },
    };
  };
  const point = (input: TextPoint): TextPoint => {
    const result = Object.freeze({ document: input.document, revision: input.revision, unit: input.unit, offset: input.offset });
    ids.local("revision", result.revision);
    return result;
  };
  const range = (input: TextRange): TextRange => {
    const result = Object.freeze({
      document: input.document, revision: input.revision, unit: input.unit, start: input.start, end: input.end,
    });
    ids.local("revision", result.revision);
    return result;
  };
  const entry = (input: RevisionEntry): RevisionEntry => {
    const result = Object.freeze({ document: input.document, revision: input.revision });
    ids.local("revision", result.revision);
    return result;
  };
  const receipt = (input: CommitReceipt): CommitReceipt => { context.check(input, "receipt"); return input; };
  const resolution = (input: PositionResolution): PositionResolution => {
    if (input.status === "present") return Object.freeze({ status: input.status, point: point(input.point) });
    if (input.status === "deleted") {
      context.check(input.before, "position"); context.check(input.after, "position");
      return Object.freeze({ status: input.status, before: input.before, after: input.after });
    }
    if (input.status !== "not-yet-created") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid position resolution");
    return Object.freeze({ status: input.status });
  };
  const snapshot = (inner: TextSnapshot): TextSnapshot => {
    methods(inner, ["text", "readUtf16", "pointUtf16", "pointUtf8", "pointScalar", "convertPoint", "rangeUtf16",
      "anchorUtf16", "stableRangeUtf16", "dispose"], "TextSnapshot");
    const revision = inner.revision, document = inner.document, lengthUtf16 = inner.lengthUtf16;
    ids.local("revision", revision);
    const held = lease(inner);
    return Object.freeze({
      document, revision, lengthUtf16,
      text: () => { held.active(); return inner.text(); },
      readUtf16: (start, end) => { held.active(); return inner.readUtf16(start, end); },
      pointUtf16: (offset) => { held.active(); return point(inner.pointUtf16(offset)); },
      pointUtf8: (offset) => { held.active(); return point(inner.pointUtf8(offset)); },
      pointScalar: (offset) => { held.active(); return point(inner.pointScalar(offset)); },
      convertPoint: (input, unit) => { held.active(); return point(inner.convertPoint(point(input), unit)); },
      rangeUtf16: (start, end) => { held.active(); return range(inner.rangeUtf16(start, end)); },
      anchorUtf16: (offset, options) => {
        held.active();
        const result = inner.anchorUtf16(offset, { affinity: options.affinity });
        context.check(result, "position"); return result;
      },
      stableRangeUtf16: (start, end, options) => {
        held.active();
        const result = inner.stableRangeUtf16(start, end, { startAffinity: options.startAffinity, endAffinity: options.endAffinity });
        context.check(result.start, "position"); context.check(result.end, "position");
        return Object.freeze({ start: result.start, end: result.end });
      },
      dispose: held.dispose,
    } satisfies TextSnapshot);
  };
  const report = (cause: unknown): void => {
    const error = cause instanceof EditorError ? cause : new EditorError("INVALID_REFERENCE", "Backend listener failed", { cause });
    if (options.onError) {
      try { options.onError(error); return; }
      catch (failure) { void Promise.resolve().then(() => { throw failure; }); return; }
    }
    void Promise.resolve().then(() => { throw error; });
  };
  const events: (() => void)[] = [];
  let scheduled = false;
  const enqueue = (action: () => void): void => {
    events.push(action);
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => {
      scheduled = false;
      const batch = events.splice(0);
      notifying = true;
      try { for (const event of batch) { try { event(); } catch (cause) { report(cause); } } }
      finally { notifying = false; }
    });
  };
  const history: HistoryQueries = Object.freeze({
    revision(input) {
      active(); const result = raw.history.revision(entry(input));
      entry(result); result.frontier.forEach((id) => ids.local("transaction", id));
      result.parents.forEach((id) => ids.local("revision", id)); return result;
    },
    transaction(id) {
      active(); ids.local("transaction", id); const result = raw.history.transaction(id);
      ids.local("transaction", result.id); ids.local("group", result.group);
      result.dependencies.forEach((id) => ids.local("transaction", id));
      result.operations.forEach((id) => ids.local("operation", id));
      ids.local("revision", result.before); ids.local("revision", result.after); return result;
    },
    transactions(input) {
      active();
      const captured = { ...input };
      ids.local("revision", captured.includedIn);
      if (captured.cursor !== undefined) ids.local("cursor", captured.cursor);
      const result = raw.history.transactions(captured);
      if (result.next !== null) ids.local("cursor", result.next);
      for (const item of result.items) {
        ids.local("transaction", item.id); ids.local("group", item.group);
        item.dependencies.forEach((id) => ids.local("transaction", id));
        item.operations.forEach((id) => ids.local("operation", id));
        ids.local("revision", item.before); ids.local("revision", item.after);
      }
      return result;
    },
    compare(input) { active(); const captured = { ...input }; ids.local("revision", captured.left); ids.local("revision", captured.right); return raw.history.compare(captured); },
    provenance(input) {
      active(); const captured = { ...input }; ids.local("revision", captured.revision);
      const result = raw.history.provenance({ ...captured, range: range(captured.range) });
      for (const span of result) { range(span.range); if (span.transaction !== null) ids.local("transaction", span.transaction); }
      return result;
    },
    resolve(input) { active(); const { position, at } = input; context.check(position, "position"); return resolution(raw.history.resolve({ position, at: entry(at) })); },
    translate(input) { active(); const captured = { ...input }; ids.local("revision", captured.to); return resolution(raw.history.translate({ ...captured, point: point(captured.point) })); },
  } satisfies HistoryQueries);
  const store: HistoryStore = {
    backend: descriptor, history,
    createDocument(input) { return write(() => entry(raw.createDocument({ id: input.id, base: { id: input.base.id, text: input.base.text } }))); },
    openWriter(input) {
      return write(() => {
        const inner = raw.openWriter({ actor: input.actor, replica: input.replica });
        methods(inner, ["dispose"], "Writer");
        const state: WriterState = { raw: inner, lease: lease(inner), heads: 0 };
        const writer: Writer = Object.freeze({
          actor: inner.actor, replica: inner.replica,
          dispose(): void {
            if (state.heads) throw new EditorError("RESOURCE_IN_USE", "RESOURCE_IN_USE: heads still borrow this writer");
            state.lease.dispose();
          },
        });
        writers.set(writer, state); return writer;
      });
    },
    revisions(input) {
      active();
      const copied = context.entries(input);
      return context.set(raw.revisions([...copied.entries()]));
    },
    fork(input) {
      return write(() => {
        const writer = writers.get(input.writer);
        if (!writer) throw new EditorError("DIFFERENT_ATOMIC_DOMAIN", "DIFFERENT_ATOMIC_DOMAIN: writer belongs to another store");
        writer.lease.active();
        const inner = raw.fork({ at: context.set(input.at), writer: writer.raw });
        methods(inner, ["checkpoint", "snapshot", "document", "commit", "merge", "checkout", "onChange", "dispose"], "EditingHead");
        const state: HeadState = { raw: inner, lease: lease(inner, () => { writer.heads--; }), undo: 0 };
        writer.heads++;
        let alive = true;
        const head: EditingHead = Object.freeze({
          checkpoint: () => { state.lease.active(); return context.checkpoint(inner.checkpoint()); },
          snapshot: (document) => { state.lease.active(); return snapshot(inner.snapshot(document)); },
          document: (document) => { state.lease.active(); inner.document(document); return Object.freeze({ head, document }); },
          commit: (command) => write(() => {
            state.lease.active();
            const expect = context.checkpoint(command.expect);
            const edits = command.edits.map((edit) => Object.freeze({ document: edit.document, range: range(edit.range), text: edit.text }));
            return receipt(inner.commit({ ...command, expect, edits }));
          }),
          merge: (command) => write(() => { state.lease.active(); return receipt(inner.merge({ expect: context.checkpoint(command.expect), source: context.set(command.source) })); }),
          checkout: (command) => write(() => { state.lease.active(); return receipt(inner.checkout({ expect: context.checkpoint(command.expect), at: context.set(command.at) })); }),
          onChange: (listener) => {
            state.lease.active();
            if (typeof listener !== "function") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: listener must be a function");
            let subscribed = true;
            const subscription = inner.onChange((event: HeadChangeEvent) => {
              const captured = Object.freeze({ change: receipt(event.change), reason: event.reason, origin: event.origin });
              enqueue(() => { if (alive && subscribed) listener(captured); });
            });
            return Object.freeze({ dispose() { if (subscribed) { subscription.dispose(); subscribed = false; } } });
          },
          dispose: () => {
            if (state.undo) throw new EditorError("RESOURCE_IN_USE", "RESOURCE_IN_USE: undo scopes still borrow this head");
            state.lease.dispose(); alive = false;
          },
        } satisfies EditingHead);
        heads.set(head, state);
        headOwners.set(head, { store, active: state.lease.active });
        return head;
      });
    },
    snapshot(input) { active(); return snapshot(raw.snapshot(entry(input))); },
    pin(input) {
      active(); const revisions = context.set(input.revisions);
      const inner = raw.pin({ revisions }); methods(inner, ["dispose"], "RetentionHandle");
      const retained = context.set(inner.revisions);
      const held = lease(inner);
      return Object.freeze({ revisions: retained, dispose: held.dispose });
    },
    exportPosition(input) {
      active(); const position = input.position; context.check(position, "position");
      const inner = raw.exportPosition({ position }); methods(inner, ["dispose"], "ExportedPosition");
      context.check(inner.position, "position"); context.check(inner.token, "positionToken");
      const held = lease(inner);
      return Object.freeze({ position: inner.position, token: inner.token, dispose: held.dispose });
    },
    importPosition(token) {
      active(); context.check(token, "positionToken");
      const inner = raw.importPosition(token); methods(inner, ["dispose"], "ExportedPosition");
      context.check(inner.position, "position"); context.check(inner.token, "positionToken");
      const held = lease(inner);
      return Object.freeze({ position: inner.position, token: inner.token, dispose: held.dispose });
    },
    exportHistory(input) {
      active();
      const result = raw.exportHistory({ target: context.set(input.target), known: context.set(input.known) });
      context.check(result, "bundle"); return result;
    },
    importHistory(bundle, input = {}): HistoryImportReport {
      return write(() => {
        context.check(bundle, "bundle");
        const missing = input.missing ?? "reject";
        if (missing !== "reject" && missing !== "defer") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid import policy");
        if (missing === "defer" && !descriptor.capabilities.deferredImport) {
          throw new EditorError("UNSUPPORTED_CAPABILITY", "UNSUPPORTED_CAPABILITY: backend does not support deferred import");
        }
        const result = raw.importHistory(bundle, { missing });
        if (result.status === "pending") {
          if (missing !== "defer") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: backend deferred a rejecting import");
          result.missing.forEach((id) => ids.local("transaction", id));
          return Object.freeze({
            status: "pending", missing: Object.freeze([...result.missing]), id: historyPendingId(result.id),
          });
        }
        return Object.freeze({ status: result.status, availableRevisions: context.set(result.availableRevisions) });
      });
    },
    onImport(listener: (event: HistoryImportEvent) => void): Disposable {
      active();
      if (typeof listener !== "function") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: listener must be a function");
      let subscribed = true;
      const subscription = raw.onImport((event) => {
        if (event.status !== "accepted" && event.status !== "rejected") {
          throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid import event status");
        }
        const captured: HistoryImportEvent = Object.freeze({
          id: historyPendingId(event.id),
          status: event.status,
          ...(event.availableRevisions === undefined ? {} : { availableRevisions: context.set(event.availableRevisions) }),
          ...(event.missing === undefined ? {} : {
            missing: Object.freeze(event.missing.map((id) => { ids.local("transaction", id); return id; })),
          }),
          ...(event.error === undefined ? {} : {
            error: event.error instanceof EditorError ? event.error
              : new EditorError("INVALID_REFERENCE", "Backend import listener failed", { cause: event.error }),
          }),
        });
        enqueue(() => { if (subscribed && !disposed) listener(captured); });
      });
      return Object.freeze({ dispose() { if (!subscribed) return; subscribed = false; subscription.dispose(); } });
    },
    async diff(input) {
      active();
      const command = { ...input };
      if (command.change !== undefined && (command.from !== undefined || command.to !== undefined)) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: Diff has exactly one basis");
      }
      const captured = command.change ? { ...command, change: receipt(command.change) } :
        { ...command, from: context.set(command.from!), to: context.set(command.to!) };
      resources++;
      try {
        const result = await raw.diff(captured);
        active(); context.set(result.from); context.set(result.to);
        for (const document of result.documents) {
          if (document.before !== null) ids.local("revision", document.before);
          if (document.after !== null) ids.local("revision", document.after);
        }
        return result;
      } finally { resources--; }
    },
    dispose() {
      if (disposed) return;
      write(() => {
        if (resources) throw new EditorError("RESOURCE_IN_USE", "RESOURCE_IN_USE: release backend handles before their store");
        raw.dispose(); disposed = true;
      });
    },
  };
  if (descriptor.capabilities.selectiveUndo) {
    Object.assign(store, {
      undo: Object.freeze({
        open(input: { head: EditingHead }): HistoryUndoScope {
          active();
          const head = heads.get(input.head);
          if (!head) throw new EditorError("DIFFERENT_ATOMIC_DOMAIN", "DIFFERENT_ATOMIC_DOMAIN: undo head belongs to another store");
          head.lease.active();
          const inner = raw.undo!.open({ head: head.raw });
          methods(inner, ["capture", "apply", "dispose"], "HistoryUndoScope");
          head.undo++;
          const held = lease(inner, () => { head.undo--; });
          const tokens = new WeakSet<HistoryUndoToken>();
          return Object.freeze({
            capture(input) {
              held.active(); const change = receipt(input.change);
              if (change.after.headId !== head.raw.checkpoint().headId) {
                throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: receipt belongs to another head");
              }
              const token = inner.capture({ change }); context.check(token, "undo"); tokens.add(token); return token;
            },
            apply(input) {
              return write(() => {
                held.active();
                const { expect, tokens: requested, direction } = input;
                const copied = [...requested];
                if (copied.some((token) => !tokens.has(token))) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: token belongs to another undo scope");
                if (direction !== "undo" && direction !== "redo") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid undo direction");
                const result = inner.apply({ expect: context.checkpoint(expect), tokens: copied, direction });
                receipt(result.change);
                if (!["applied", "partial", "no-effect"].includes(result.status)) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid undo result");
                return Object.freeze({ status: result.status, change: result.change });
              });
            },
            dispose: held.dispose,
          } satisfies HistoryUndoScope);
        },
      }),
    });
  }
  return Object.freeze(store);
}
