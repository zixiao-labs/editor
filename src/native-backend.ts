import type {
  CommitReceipt, DiffInput, DiffOptions, DiffReport, Disposable, DocumentDiff, DocumentTarget, EditingHead,
  ExportedPosition, HeadChangeEvent, HeadCheckpoint, HistoryBundle, HistoryImportEvent, HistoryImportReport,
  HistoryPage, HistoryQueries, HistoryStore, HistoryStoreOptions, PositionResolution, PositionToken, ProvenanceSpan,
  RetentionHandle, RevisionEntry, RevisionInfo, RevisionSet, SourceEdit, StablePosition, TextPoint, TextRange,
  TextSnapshot, TransactionInfo, Writer,
} from "./contracts/core.js";
import type {
  HistoryBackend, HistoryBackendContext, HistoryOpaqueStore, HistoryStoreImplementation,
} from "./contracts/history-backend.js";
import { computeDocumentDiff, measureReport, resolveDiffOptions } from "./diff.js";
import { EditorError } from "./errors.js";
import { utf8Length } from "./history/bytes.js";
import { canonicalCopy, canonicalJson } from "./history/canonical.js";
import type { NativeTransaction } from "./history/native-history.js";
import { NativeStore, type NativeAcceptance, type NativeHistoryBundle } from "./history/native-store.js";
import { compareIds } from "./history/sequence.js";
import { MAX_HISTORY_BYTES } from "./history/transaction-group.js";
import { defineHistoryBackend } from "./history-backend.js";
import {
  documentId, historyPendingId, type DocumentId, type ExternalBaseId, type HeadId, type HeadStamp,
  type HistoryCursor, type HistoryPendingId, type RevisionId, type TransactionId,
} from "./identity.js";
import { readSourcePosition, restoreSourcePosition, type SourcePositionPayload } from "./model/source-revision.js";
import { nativeDescriptor, nativeContextState } from "./native-definition.js";

const MAX_PENDING_BYTES = 32 * 1024 * 1024;
let providerSerial = 0;

interface PendingBatch {
  readonly id: HistoryPendingId;
  readonly canonical: string;
  readonly payload: NativeHistoryBundle;
  readonly size: number;
  readonly missing: readonly TransactionId[];
  readonly byId: ReadonlyMap<string, NativeTransaction>;
  readonly canonicals: Map<string, string>;
}

/**
 * Default native backend behind `createHistoryStore`. Talks to the validated
 * kernel exclusively through the backend SDK context: every distributed ID is
 * issued in the backend namespace, positions are owner-scoped opaque values,
 * and bundles/tokens are portable within the same protocol family.
 */
class NativeProvider implements HistoryStoreImplementation {
  readonly #context: HistoryBackendContext;
  readonly #options: HistoryStoreOptions;
  readonly #store: NativeStore;
  readonly #positions: HistoryOpaqueStore<StablePosition, SourcePositionPayload>;
  readonly #positionTokens: HistoryOpaqueStore<PositionToken, SourcePositionPayload>;
  readonly #bundles: HistoryOpaqueStore<HistoryBundle, NativeHistoryBundle>;
  readonly #receiptCache = new WeakMap<CommitReceipt, CommitReceipt>();
  readonly #receiptData = new WeakMap<CommitReceipt, Readonly<{
    before: readonly RevisionEntry[]; after: readonly RevisionEntry[]; transactions: readonly TransactionId[];
  }>>();
  readonly #pending: PendingBatch[] = [];
  readonly #pendingIndex = new Map<string, Set<PendingBatch>>();
  readonly #listeners = new Set<(event: HistoryImportEvent) => void>();
  readonly #scope = (++providerSerial).toString(36);
  #pendingBytes = 0;
  #pendingSerial = 0;
  #pins = 0;
  #exported = 0;
  #disposed = false;
  readonly history: HistoryQueries;

  constructor(context: HistoryBackendContext, options: HistoryStoreOptions) {
    this.#context = context;
    this.#options = Object.freeze({ ...options });
    this.#positions = context.positions<SourcePositionPayload>();
    this.#positionTokens = context.positionTokens<SourcePositionPayload>();
    this.#bundles = context.bundles<NativeHistoryBundle>();
    this.#store = new NativeStore(options);
    const provider = this;
    this.history = Object.freeze({
      revision(input: RevisionEntry): RevisionInfo {
        const info = provider.#store.history.revision(provider.#localEntry(input));
        return Object.freeze({
          document: info.document,
          revision: provider.#identity("revision", info.revision),
          parents: Object.freeze(info.parents.map((id) => provider.#identity("revision", id))),
          frontier: Object.freeze(info.frontier.map((id) => provider.#identity("transaction", id))),
          base: info.base,
        });
      },
      transaction(id: TransactionId): TransactionInfo {
        return provider.#txInfo(provider.#store.history.transaction(
          provider.#strip("transaction", id) as unknown as TransactionId,
        ));
      },
      transactions(input: Parameters<HistoryQueries["transactions"]>[0]): HistoryPage {
        const page = provider.#store.history.transactions({
          document: input.document,
          includedIn: provider.#strip("revision", input.includedIn) as unknown as RevisionId,
          limit: input.limit,
          ...(input.cursor === undefined ? {} : { cursor: provider.#strip("cursor", input.cursor) as unknown as HistoryCursor }),
        });
        return Object.freeze({
          items: Object.freeze(page.items.map((info) => provider.#txInfo(info))),
          next: page.next === null ? null : provider.#identity("cursor", page.next),
        });
      },
      compare(input: Parameters<HistoryQueries["compare"]>[0]): ReturnType<HistoryQueries["compare"]> {
        return provider.#store.history.compare({
          document: input.document,
          left: provider.#strip("revision", input.left) as unknown as RevisionId,
          right: provider.#strip("revision", input.right) as unknown as RevisionId,
        });
      },
      provenance(input: Parameters<HistoryQueries["provenance"]>[0]): readonly ProvenanceSpan[] {
        const spans = provider.#store.history.provenance({
          document: input.document,
          revision: provider.#strip("revision", input.revision) as unknown as RevisionId,
          range: provider.#localRange(input.range),
        });
        return Object.freeze(spans.map((span) => Object.freeze({
          range: provider.#sdkRange(span.range),
          transaction: span.transaction === null ? null : provider.#identity("transaction", span.transaction),
          actor: span.actor,
          ...(span.attribution === undefined ? {} : { attribution: span.attribution }),
        })));
      },
      resolve(input: Parameters<HistoryQueries["resolve"]>[0]): PositionResolution {
        const payload = provider.#positions.read(input.position);
        const position = restoreSourcePosition(payload);
        return provider.#resolution(provider.#store.history.resolve({
          position, at: provider.#localEntry(input.at),
        }));
      },
      translate(input: Parameters<HistoryQueries["translate"]>[0]): PositionResolution {
        return provider.#resolution(provider.#store.history.translate({
          point: provider.#localPoint(input.point),
          to: provider.#strip("revision", input.to) as unknown as RevisionId,
          affinity: input.affinity,
        }));
      },
    } satisfies HistoryQueries);
  }

  #identity<K extends "revision" | "transaction" | "group" | "head" | "stamp" | "commit" | "cursor" | "operation">(
    kind: K, local: string,
  ): never {
    return this.#context.identities.create(kind, local) as never;
  }

  #strip(kind: "revision" | "transaction" | "group" | "head" | "stamp" | "cursor", id: string): string {
    return this.#context.identities.local(kind, id as never);
  }

  #localEntry(entry: RevisionEntry): RevisionEntry {
    return Object.freeze({
      document: documentId(entry.document),
      revision: this.#strip("revision", entry.revision) as unknown as RevisionId,
    });
  }

  #sdkEntry(entry: RevisionEntry): RevisionEntry {
    return Object.freeze({
      document: entry.document,
      revision: this.#identity("revision", entry.revision as unknown as string),
    });
  }

  #localEntries(input: Iterable<RevisionEntry>): RevisionEntry[] {
    const entries: RevisionEntry[] = [];
    for (const entry of input) entries.push(this.#localEntry(entry));
    return entries;
  }

  #localSet(input: RevisionSet): RevisionSet {
    return this.#store.revisions(this.#localEntries(input.entries()));
  }

  #sdkSet(entries: Iterable<RevisionEntry>): RevisionSet {
    const wrapped = [...entries]
      .map((entry) => Object.freeze({
        document: documentId(entry.document),
        revision: this.#identity("revision", entry.revision as unknown as string),
      }))
      .sort((a, b) => compareIds(a.document, b.document));
    const values = new Map(wrapped.map((entry) => [entry.document, entry.revision]));
    return Object.freeze({
      get(document: DocumentId): RevisionId {
        const revision = values.get(document);
        if (revision === undefined) {
          throw new EditorError("UNKNOWN_DOCUMENT", "UNKNOWN_DOCUMENT: document absent from revision set");
        }
        return revision;
      },
      has: (document: DocumentId) => values.has(document),
      entries: () => wrapped.values(),
    });
  }

  #sdkCheckpoint(checkpoint: HeadCheckpoint): HeadCheckpoint {
    return Object.freeze({
      headId: this.#identity("head", checkpoint.headId as unknown as string),
      stamp: this.#identity("stamp", checkpoint.stamp as unknown as string),
      revisions: this.#sdkSet(checkpoint.revisions.entries()),
    });
  }

  #localCheckpoint(checkpoint: HeadCheckpoint): HeadCheckpoint {
    return Object.freeze({
      headId: this.#strip("head", checkpoint.headId) as unknown as HeadId,
      stamp: this.#strip("stamp", checkpoint.stamp) as unknown as HeadStamp,
      revisions: this.#store.revisions(this.#localEntries(checkpoint.revisions.entries())),
    });
  }

  #sdkPoint(point: TextPoint): TextPoint {
    return Object.freeze({
      document: point.document,
      revision: this.#identity("revision", point.revision as unknown as string),
      unit: point.unit, offset: point.offset,
    });
  }

  #localPoint(point: TextPoint): TextPoint {
    return Object.freeze({
      document: point.document,
      revision: this.#strip("revision", point.revision) as unknown as RevisionId,
      unit: point.unit, offset: point.offset,
    });
  }

  #sdkRange(range: TextRange): TextRange {
    return Object.freeze({
      document: range.document,
      revision: this.#identity("revision", range.revision as unknown as string),
      unit: range.unit, start: range.start, end: range.end,
    });
  }

  #localRange(range: TextRange): TextRange {
    return Object.freeze({
      document: range.document,
      revision: this.#strip("revision", range.revision) as unknown as RevisionId,
      unit: range.unit, start: range.start, end: range.end,
    });
  }

  #localEdit(edit: SourceEdit): SourceEdit {
    return Object.freeze({ document: edit.document, range: this.#localRange(edit.range), text: edit.text });
  }

  #wrapSnapshot(native: TextSnapshot): TextSnapshot {
    const provider = this;
    const position = (value: StablePosition): StablePosition => provider.#positions.create(readSourcePosition(value));
    return Object.freeze({
      document: native.document,
      revision: provider.#identity("revision", native.revision as unknown as string),
      lengthUtf16: native.lengthUtf16,
      text: () => native.text(),
      readUtf16: (start: number, end: number) => native.readUtf16(start, end),
      pointUtf16: (offset: number) => provider.#sdkPoint(native.pointUtf16(offset)),
      pointUtf8: (offset: number) => provider.#sdkPoint(native.pointUtf8(offset)),
      pointScalar: (offset: number) => provider.#sdkPoint(native.pointScalar(offset)),
      convertPoint: (input: TextPoint, unit: TextPoint["unit"]) => provider.#sdkPoint(native.convertPoint(provider.#localPoint(input), unit)),
      rangeUtf16: (start: number, end: number) => provider.#sdkRange(native.rangeUtf16(start, end)),
      anchorUtf16: (offset: number, options: { affinity: "before" | "after" }) =>
        position(native.anchorUtf16(offset, { affinity: options.affinity })),
      stableRangeUtf16: (start: number, end: number, options: {
        startAffinity: "before" | "after"; endAffinity: "before" | "after";
      }) => {
        const stable = native.stableRangeUtf16(start, end, {
          startAffinity: options.startAffinity, endAffinity: options.endAffinity,
        });
        return Object.freeze({ start: position(stable.start), end: position(stable.end) });
      },
      dispose: () => native.dispose(),
    } satisfies TextSnapshot);
  }

  #wrapHead(native: EditingHead): EditingHead {
    const provider = this;
    const head: EditingHead = Object.freeze({
      checkpoint: (): HeadCheckpoint => provider.#sdkCheckpoint(native.checkpoint()),
      snapshot: (document: DocumentId): TextSnapshot => provider.#wrapSnapshot(native.snapshot(document)),
      document: (document: DocumentId): DocumentTarget => Object.freeze({ head, document }),
      commit: (input: Parameters<EditingHead["commit"]>[0]): CommitReceipt => provider.#wrapReceipt(native.commit({
        expect: provider.#localCheckpoint(input.expect),
        edits: input.edits.map((edit) => provider.#localEdit(edit)),
        origin: input.origin,
        ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
      })),
      merge: (input: Parameters<EditingHead["merge"]>[0]): CommitReceipt => provider.#wrapReceipt(native.merge({
        expect: provider.#localCheckpoint(input.expect),
        source: provider.#localSet(input.source),
      })),
      checkout: (input: Parameters<EditingHead["checkout"]>[0]): CommitReceipt => provider.#wrapReceipt(native.checkout({
        expect: provider.#localCheckpoint(input.expect),
        at: provider.#localSet(input.at),
      })),
      onChange: (listener: (event: HeadChangeEvent) => void): Disposable => native.onChange((event) => {
        listener(Object.freeze({
          change: provider.#wrapReceipt(event.change), reason: event.reason, origin: event.origin,
        }));
      }),
      dispose: () => native.dispose(),
    } satisfies EditingHead);
    return head;
  }

  #wrapReceipt(native: CommitReceipt): CommitReceipt {
    const cached = this.#receiptCache.get(native);
    if (cached !== undefined) return cached;
    const identities = this.#context.identities;
    const receipt = this.#context.issueReceipt({
      id: identities.create("commit", native.id as unknown as string),
      before: this.#sdkCheckpoint(native.before),
      after: this.#sdkCheckpoint(native.after),
      documents: [...native.documents],
      transactions: native.transactions.map((id) => identities.create("transaction", id as unknown as string)),
      groups: native.groups.map((id) => identities.create("group", id as unknown as string)),
      status: native.status,
    });
    this.#receiptCache.set(native, receipt);
    this.#receiptData.set(receipt, Object.freeze({
      before: Object.freeze([...native.before.revisions.entries()]),
      after: Object.freeze([...native.after.revisions.entries()]),
      transactions: Object.freeze([...native.transactions]),
    }));
    return receipt;
  }

  #txInfo(info: TransactionInfo): TransactionInfo {
    return Object.freeze({
      id: this.#identity("transaction", info.id as unknown as string),
      document: info.document,
      group: this.#identity("group", info.group as unknown as string),
      dependencies: Object.freeze(info.dependencies.map((id) => this.#identity("transaction", id as unknown as string))),
      operations: Object.freeze(info.operations.map((id) => this.#identity("operation", id as unknown as string))),
      actor: info.actor,
      origin: info.origin,
      ...(info.attribution === undefined ? {} : { attribution: info.attribution }),
      before: this.#identity("revision", info.before as unknown as string),
      after: this.#identity("revision", info.after as unknown as string),
    });
  }

  #resolution(resolution: PositionResolution): PositionResolution {
    if (resolution.status === "present") {
      return Object.freeze({ status: "present", point: this.#sdkPoint(resolution.point) });
    }
    if (resolution.status === "deleted") {
      return Object.freeze({
        status: "deleted",
        before: this.#positions.create(readSourcePosition(resolution.before)),
        after: this.#positions.create(readSourcePosition(resolution.after)),
      });
    }
    return Object.freeze({ status: "not-yet-created" });
  }

  #text(entry: RevisionEntry): string {
    const snapshot = this.#store.snapshot(entry);
    try { return snapshot.text(); } finally { snapshot.dispose(); }
  }

  #report(cause: unknown): void {
    const error = cause instanceof EditorError ? cause
      : new EditorError("INVALID_REFERENCE", "import listener failed", { cause });
    if (this.#options.onError) {
      try { this.#options.onError(error); return; }
      catch (failure) { void Promise.resolve().then(() => { throw failure; }); return; }
    }
    void Promise.resolve().then(() => { throw error; });
  }

  #emit(event: HistoryImportEvent): void {
    for (const listener of [...this.#listeners]) {
      try { listener(event); } catch (cause) { this.#report(cause); }
    }
  }

  // ---- HistoryStoreImplementation ----

  createDocument(input: { id: DocumentId; base: { id: ExternalBaseId; text: string } }): RevisionEntry {
    return this.#sdkEntry(this.#store.createDocument(input));
  }

  openWriter(input: { actor: Parameters<HistoryStore["openWriter"]>[0]["actor"]; replica: Parameters<HistoryStore["openWriter"]>[0]["replica"] }): Writer {
    return this.#store.openWriter(input);
  }

  revisions(entries: readonly RevisionEntry[]): RevisionSet {
    return this.#sdkSet(this.#store.revisions(entries.map((entry) => this.#localEntry(entry))).entries());
  }

  fork(input: { at: RevisionSet; writer: Writer }): EditingHead {
    return this.#wrapHead(this.#store.fork({ at: this.#localSet(input.at), writer: input.writer }));
  }

  snapshot(input: RevisionEntry): TextSnapshot {
    return this.#wrapSnapshot(this.#store.snapshot(this.#localEntry(input)));
  }

  pin(input: { revisions: RevisionSet }): RetentionHandle {
    const local = this.#localSet(input.revisions);
    this.#pins++;
    let disposed = false;
    return Object.freeze({
      revisions: this.#sdkSet(local.entries()),
      dispose: () => { if (disposed) return; disposed = true; this.#pins--; },
    });
  }

  exportPosition(input: { position: StablePosition }): ExportedPosition {
    const payload = this.#positions.read(input.position);
    restoreSourcePosition(payload);
    const root = this.#store.rootOf(payload.document);
    if (root.root !== payload.root) {
      throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: position belongs to another exact root");
    }
    const token = this.#positionTokens.create(canonicalCopy(payload));
    this.#exported++;
    let disposed = false;
    return Object.freeze({
      position: input.position,
      token,
      dispose: () => { if (disposed) return; disposed = true; this.#exported--; },
    });
  }

  importPosition(token: PositionToken): ExportedPosition {
    const payload = this.#positionTokens.read(token);
    restoreSourcePosition(payload);
    const root = this.#store.rootOf(payload.document);
    if (root.root !== payload.root) {
      throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: position belongs to another exact root");
    }
    const position = this.#positions.create(canonicalCopy(payload));
    this.#exported++;
    let disposed = false;
    return Object.freeze({
      position,
      token,
      dispose: () => { if (disposed) return; disposed = true; this.#exported--; },
    });
  }

  exportHistory(input: { target: RevisionSet; known: RevisionSet }): HistoryBundle {
    const bundle = this.#store.exportTyped({
      target: this.#localSet(input.target),
      known: this.#localSet(input.known),
    });
    return this.#bundles.create(canonicalCopy(bundle));
  }

  importHistory(bundle: HistoryBundle, input: { missing?: "reject" | "defer" } = {}): HistoryImportReport {
    const mode = input.missing ?? "reject";
    const payload = this.#bundles.read(bundle);
    let accepted: NativeAcceptance | null = null;
    let failure: unknown;
    try { accepted = this.#store.acceptBundle(payload); }
    catch (cause) { failure = cause; }
    if (accepted !== null) {
      this.#evictConflictingPending(payload);
      if (accepted.status === "accepted") this.#resolvePending();
      return Object.freeze({
        status: accepted.status,
        availableRevisions: this.#sdkSet(accepted.availableRevisions.entries()),
      });
    }
    if (mode !== "defer" || !(failure instanceof EditorError) || failure.code !== "MISSING_DEPENDENCIES") {
      throw failure;
    }
    this.#evictConflictingPending(payload);
    const canonical = canonicalJson(payload, MAX_HISTORY_BYTES);
    const existing = this.#pending.find((batch) => batch.canonical === canonical);
    if (existing !== undefined) return this.#pendingReport(existing);
    const size = utf8Length(canonical);
    if (this.#pendingBytes + size > MAX_PENDING_BYTES) {
      throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: deferred import storage exceeds its documented bound");
    }
    const byId = new Map<string, NativeTransaction>();
    for (const history of payload.histories) {
      for (const transaction of history.transactions) byId.set(transaction.id as unknown as string, transaction);
    }
    const batch: PendingBatch = {
      id: historyPendingId(`pending:${this.#scope}:${++this.#pendingSerial}`),
      canonical, payload, size,
      missing: this.#missingFor(payload),
      byId,
      canonicals: new Map(),
    };
    this.#pending.push(batch);
    this.#pendingBytes += size;
    for (const id of byId.keys()) {
      let claims = this.#pendingIndex.get(id);
      if (claims === undefined) this.#pendingIndex.set(id, claims = new Set());
      claims.add(batch);
    }
    return this.#pendingReport(batch);
  }

  onImport(listener: (event: HistoryImportEvent) => void): Disposable {
    this.#listeners.add(listener);
    return Object.freeze({ dispose: () => { this.#listeners.delete(listener); } });
  }

  #pendingReport(batch: PendingBatch): HistoryImportReport {
    return Object.freeze({
      status: "pending" as const,
      missing: Object.freeze(batch.missing.map((id) => this.#identity("transaction", id as unknown as string))),
      id: batch.id,
    });
  }

  #removePending(batch: PendingBatch): void {
    const index = this.#pending.indexOf(batch);
    if (index < 0) return;
    this.#pending.splice(index, 1);
    this.#pendingBytes -= batch.size;
    for (const id of batch.byId.keys()) {
      const claims = this.#pendingIndex.get(id);
      if (claims === undefined) continue;
      claims.delete(batch);
      if (!claims.size) this.#pendingIndex.delete(id);
    }
  }

  #evictPending(batch: PendingBatch, error: EditorError): void {
    if (!this.#pending.includes(batch)) return;
    this.#removePending(batch);
    this.#emit(Object.freeze({ id: batch.id, status: "rejected" as const, error }));
  }

  /** A newer claim for the same transaction identity defeats a stale pending payload. */
  #evictConflictingPending(payload: NativeHistoryBundle): void {
    if (!this.#pending.length) return;
    for (const history of payload.histories) {
      for (const transaction of history.transactions) {
        const id = transaction.id as unknown as string;
        const claims = this.#pendingIndex.get(id);
        if (claims === undefined || !claims.size) continue;
        const canonical = canonicalJson(transaction);
        for (const batch of [...claims]) {
          if (!this.#pending.includes(batch)) continue;
          const held = batch.byId.get(id);
          if (held === undefined) continue;
          let heldCanonical = batch.canonicals.get(id);
          if (heldCanonical === undefined) {
            heldCanonical = canonicalJson(held);
            batch.canonicals.set(id, heldCanonical);
          }
          if (heldCanonical !== canonical) {
            this.#evictPending(batch, new EditorError(
              "IDENTITY_CONFLICT",
              "IDENTITY_CONFLICT: a newer import replaced a pending transaction identity with another payload",
            ));
          }
        }
      }
    }
  }

  #missingFor(payload: NativeHistoryBundle): readonly TransactionId[] {
    const missing = new Set<string>();
    const byDocument = new Map<string, Map<string, NativeTransaction>>();
    for (const history of payload.histories) {
      const map = new Map<string, NativeTransaction>();
      for (const transaction of history.transactions) map.set(transaction.id as unknown as string, transaction);
      byDocument.set(history.document, map);
    }
    for (const history of payload.histories) {
      const map = byDocument.get(history.document)!;
      for (const transaction of history.transactions) {
        for (const dependency of transaction.depends) {
          const id = dependency as unknown as string;
          if (!map.has(id) && !this.#store.hasTransaction(history.document, dependency)) missing.add(id);
        }
      }
    }
    for (const target of payload.target) {
      const map = byDocument.get(target.document);
      for (const id of target.frontier) {
        const key = id as unknown as string;
        if (map?.has(key)) continue;
        if (!this.#store.hasTransaction(target.document, id)) missing.add(key);
      }
    }
    return Object.freeze([...missing].sort(compareIds).map((id) => id as unknown as TransactionId));
  }

  #resolvePending(): void {
    let progress = true;
    while (progress && this.#pending.length) {
      progress = false;
      for (const batch of [...this.#pending]) {
        if (!this.#pending.includes(batch)) continue;
        let result: NativeAcceptance;
        try { result = this.#store.acceptBundle(batch.payload); }
        catch (cause) {
          if (cause instanceof EditorError && cause.code === "MISSING_DEPENDENCIES") continue;
          this.#evictPending(batch, cause instanceof EditorError ? cause
            : new EditorError("INVALID_REFERENCE", "deferred import failed after publication", { cause }));
          progress = true;
          continue;
        }
        this.#removePending(batch);
        progress = true;
        this.#emit(Object.freeze({
          id: batch.id, status: "accepted" as const,
          availableRevisions: this.#sdkSet(result.availableRevisions.entries()),
        }));
      }
    }
  }

  async diff(input: DiffInput & DiffOptions): Promise<DiffReport> {
    const options = resolveDiffOptions(input);
    if (input.signal !== undefined && input.signal.aborted) {
      throw new EditorError("CANCELLED", "CANCELLED: diff computation was cancelled");
    }
    let basis: "commit" | "versions";
    let fromEntries: readonly RevisionEntry[];
    let toEntries: readonly RevisionEntry[];
    let transactionIds: readonly TransactionId[] | null = null;
    if (input.change !== undefined) {
      const data = this.#receiptData.get(input.change);
      if (data === undefined) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: receipt was not issued by this store");
      }
      basis = "commit";
      fromEntries = data.before;
      toEntries = data.after;
      transactionIds = data.transactions;
    } else {
      if (input.from === undefined || input.to === undefined) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: diff needs exactly one basis");
      }
      basis = "versions";
      fromEntries = [...this.#localSet(input.from).entries()];
      toEntries = [...this.#localSet(input.to).entries()];
    }
    const fromMap = new Map(fromEntries.map((entry) => [entry.document, entry.revision]));
    const toMap = new Map(toEntries.map((entry) => [entry.document, entry.revision]));
    const documents = [...new Set([...fromMap.keys(), ...toMap.keys()])].sort(compareIds);
    const transactionInfos: TransactionInfo[] = [];
    if (transactionIds !== null) {
      for (const id of transactionIds) {
        transactionInfos.push(this.#txInfo(this.#store.history.transaction(id)));
      }
    } else {
      for (const document of documents) {
        const to = toMap.get(document);
        if (to === undefined) continue;
        for (const info of this.#store.difference({ document, from: fromMap.get(document) ?? null, to })) {
          transactionInfos.push(this.#txInfo(info));
        }
      }
    }
    const diffs: DocumentDiff[] = [];
    for (const document of documents) {
      if (input.signal !== undefined && input.signal.aborted) {
        throw new EditorError("CANCELLED", "CANCELLED: diff computation was cancelled");
      }
      const before = fromMap.get(document) ?? null;
      const after = toMap.get(document) ?? null;
      if (before !== null && after !== null && before === after) continue;
      const beforeText = before === null ? "" : this.#text({ document, revision: before });
      const afterText = after === null ? "" : this.#text({ document, revision: after });
      if (before !== null && after !== null && beforeText === afterText) continue;
      const beforeSdk = before === null ? null : this.#identity("revision", before as unknown as string);
      const afterSdk = after === null ? null : this.#identity("revision", after as unknown as string);
      const computed = computeDocumentDiff({
        document, before: beforeSdk, after: afterSdk, beforeText, afterText,
        contextLines: options.contextLines, intraline: options.intraline,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      diffs.push(Object.freeze({
        document,
        before: beforeSdk,
        after: afterSdk,
        kind: before === null ? "added" : after === null ? "removed" : "modified",
        beforeText, afterText,
        replacements: computed.replacements, hunks: computed.hunks,
      } satisfies DocumentDiff));
    }
    const report: DiffReport = Object.freeze({
      schemaVersion: 1 as const,
      basis,
      from: this.#sdkSet(fromEntries),
      to: this.#sdkSet(toEntries),
      transactions: Object.freeze(transactionInfos),
      documents: Object.freeze(diffs),
      maxOutputBytes: options.maxOutputBytes,
    });
    if (measureReport(report) > options.maxOutputBytes) {
      throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: diff report exceeds its output budget");
    }
    return report;
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#pins || this.#exported) {
      throw new EditorError("RESOURCE_IN_USE", "RESOURCE_IN_USE: release pins and exported positions first");
    }
    this.#disposed = true;
    // Pending imports are dropped with their owning store; durability is product-owned.
    this.#pending.length = 0;
    this.#pendingIndex.clear();
    this.#pendingBytes = 0;
    this.#listeners.clear();
    this.#store.dispose();
  }
}

const nativeBackend: HistoryBackend = defineHistoryBackend({
  descriptor: nativeDescriptor,
  createStore(context, options): HistoryStoreImplementation {
    return new NativeProvider(context, options);
  },
});

/**
 * Default native FugueMax history store. Products that need another engine use
 * `defineHistoryBackend` with their own complete implementation instead of
 * patching this one; `store.backend` reports the stable protocol identity.
 */
export function createHistoryStore(options?: HistoryStoreOptions): HistoryStore {
  return nativeBackend.createStore(options);
}

export { nativeContextState, nativeDescriptor };
