import type {
  CommitReceipt, EditingHead, HeadChangeEvent, HeadCheckpoint, HistoryPage, HistoryQueries,
  HistoryStore, HistoryStoreOptions, ProvenanceSpan, RevisionEntry, RevisionInfo, RevisionSet, SourceEdit,
  TextSnapshot, TransactionInfo, Writer,
} from "../contracts/core.js";
import { TextIndex } from "../coordinates/text-index.js";
import { EditorError } from "../errors.js";
import {
  documentId, operationId, revisionId, type ActorId, type CommitId, type DocumentId,
  type HeadId, type HeadStamp, type HistoryCursor, type ReplicaId, type RevisionId,
  type TransactionGroupId, type TransactionId,
} from "../identity.js";
import { canonicalCopy, canonicalJson } from "./canonical.js";
import { checkTransactionId, NativeWriter } from "./identity.js";
import { NativeHistory, transactionMetadata, type NativeDraft, type NativeTransaction } from "./native-history.js";
import { compareIds, ordinalId } from "./sequence.js";
import { assertGroupClosed, validateGroups, type GroupContext } from "./group-closure.js";
import {
  createManifest, historyBudget, MAX_HISTORY_BYTES, validateManifest, type NativeGroupManifest,
} from "./transaction-group.js";

export interface NativeHistoryTarget {
  readonly document: DocumentId;
  readonly root: string;
  readonly frontier: readonly TransactionId[];
}
/** Detached typed transport only; no public HistoryBundle, wire codec or defer queue. */
export interface NativeHistoryBundle {
  readonly manifests: readonly NativeGroupManifest[];
  readonly histories: readonly Readonly<{ document: DocumentId; root: string; transactions: readonly NativeTransaction[] }>[];
  readonly target: readonly NativeHistoryTarget[];
}
export interface NativeAcceptance {
  readonly status: "accepted" | "duplicate";
  readonly availableRevisions: RevisionSet;
}

interface WriterState {
  readonly native: NativeWriter;
  heads: number;
  disposed: boolean;
}
interface Listener {
  readonly callback: (event: HeadChangeEvent) => void;
  active: boolean;
}
interface HeadState {
  readonly writer: WriterState;
  checkpoint: HeadCheckpoint;
  stamp: bigint;
  disposed: boolean;
  readonly listeners: Set<Listener>;
}
interface QueuedEvent {
  readonly event: HeadChangeEvent;
  readonly listeners: readonly Listener[];
}

let storeSerial = 0n; // Process-local identities, NEVER distributed history IDs.

/** Values remain readable after store disposal; only handles borrow the store. */
function revisionSet(entries: readonly RevisionEntry[]): RevisionSet {
  const sorted = entries.map((entry) => Object.freeze({ ...entry }))
    .sort((a, b) => compareIds(a.document, b.document));
  const values = new Map(sorted.map((entry) => [entry.document, entry.revision]));
  return Object.freeze({
    get(document: DocumentId): RevisionId {
      const revision = values.get(document);
      if (!revision) throw new EditorError("UNKNOWN_DOCUMENT", "UNKNOWN_DOCUMENT: document absent from revision set");
      return revision;
    },
    has: (document: DocumentId) => values.has(document),
    entries: () => sorted.values(),
  });
}

/**
 * Internal store/head orchestration, NOT the public HistoryStore factory.
 *
 * Multi-source commits and typed transfers stage complete immutable groups.
 * This is not the public codec, defer queue, undo/retention or Diff implementation.
 */
export class NativeStore {
  readonly #scope = String(++storeSerial);
  readonly #options: HistoryStoreOptions;
  readonly #documents = new Map<DocumentId, NativeHistory>();
  readonly #transactionDocuments = new Map<TransactionId, DocumentId>();
  readonly #groups = new Map<TransactionGroupId, NativeGroupManifest>();
  readonly #writers = new WeakMap<Writer, WriterState>();
  readonly #activeWriters = new Set<WriterState>();
  readonly #streams = new Set<string>();
  readonly #ownedStreams = new Set<string>();
  readonly #heads = new Set<HeadState>();
  readonly #receipts = new WeakSet<CommitReceipt>();
  readonly #cursors = new Map<HistoryCursor, Readonly<{ document: DocumentId; revision: RevisionId; offset: number }>>();
  readonly #events: QueuedEvent[] = [];
  #localSerial = 0n;
  #snapshots = 0;
  #writing = false;
  #notifying = false;
  #scheduled = false;
  #disposed = false;
  readonly history: HistoryQueries;

  constructor(options: HistoryStoreOptions = {}) {
    this.#options = Object.freeze({ ...options });
    this.history = Object.freeze({
      revision: (entry: RevisionEntry): RevisionInfo => this.#revisionInfo(entry),
      transaction: (id: TransactionId): TransactionInfo => this.#transactionInfo(id),
      transactions: (input: Parameters<HistoryQueries["transactions"]>[0]): HistoryPage => this.#page(input),
      compare: (input: Parameters<HistoryQueries["compare"]>[0]): ReturnType<HistoryQueries["compare"]> => {
        const history = this.#document(input.document);
        const left = new Set(history.transactions(input.left).map((tx) => tx.id));
        const right = new Set(history.transactions(input.right).map((tx) => tx.id));
        const leftInRight = [...left].every((id) => right.has(id));
        const rightInLeft = [...right].every((id) => left.has(id));
        return leftInRight ? rightInLeft ? "equal" : "ancestor" : rightInLeft ? "descendant" : "concurrent";
      },
      provenance: (input: Parameters<HistoryQueries["provenance"]>[0]): readonly ProvenanceSpan[] => this.#provenance(input),
      resolve: (input: Parameters<HistoryQueries["resolve"]>[0]): ReturnType<HistoryQueries["resolve"]> =>
        this.#document(input.at.document).source(input.at.revision).resolve(input.position),
      translate: (input: Parameters<HistoryQueries["translate"]>[0]): ReturnType<HistoryQueries["translate"]> => {
        const history = this.#document(input.point.document);
        return history.source(input.point.revision).translate(input.point, history.source(input.to), input.affinity);
      },
    });
    Object.freeze(this);
  }

  #active(): void {
    if (this.#disposed) throw new EditorError("DISPOSED", "DISPOSED: history store has been released");
  }

  #write<T>(action: () => T): T {
    this.#active();
    if (this.#writing || this.#notifying) throw new EditorError("REENTRANT_WRITE", "REENTRANT_WRITE: schedule writes after notification");
    this.#writing = true;
    try { return action(); } finally { this.#writing = false; }
  }

  #document(document: DocumentId): NativeHistory {
    this.#active();
    const history = this.#documents.get(document);
    if (!history) throw new EditorError("UNKNOWN_DOCUMENT", "UNKNOWN_DOCUMENT: document was not registered");
    return history;
  }

  #context(
    documents: ReadonlyMap<DocumentId, NativeHistory> = this.#documents,
    groups: ReadonlyMap<TransactionGroupId, NativeGroupManifest> = this.#groups,
    owners: ReadonlyMap<TransactionId, DocumentId> = this.#transactionDocuments,
  ): GroupContext { return { documents, groups, owners }; }

  group(id: TransactionGroupId): NativeGroupManifest {
    this.#active();
    const group = this.#groups.get(id);
    if (!group) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown transaction group");
    return group;
  }

  #registerGroup(groups: Map<TransactionGroupId, NativeGroupManifest>, manifest: NativeGroupManifest): void {
    const previous = groups.get(manifest.id);
    if (previous && canonicalJson(previous) !== canonicalJson(manifest)) {
      throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: manifest identity already has another payload");
    }
    groups.set(manifest.id, manifest);
  }

  createDocument(input: Parameters<HistoryStore["createDocument"]>[0]): RevisionEntry {
    return this.#write(() => {
      const history = new NativeHistory({ document: input.id, base: input.base.id, text: input.base.text });
      const previous = this.#documents.get(history.root.document);
      if (previous && (previous.root.id !== history.root.id || previous.root.base !== history.root.base ||
        previous.root.text !== history.root.text)) {
        throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: document already has another base or exact initial text");
      }
      if (!previous) this.#documents.set(history.root.document, history);
      return Object.freeze({ document: history.root.document, revision: history.initial });
    });
  }

  openWriter(input: { actor: ActorId; replica: ReplicaId }): Writer {
    return this.#write(() => {
      const native = new NativeWriter({
        ...input, ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
      });
      if (this.#streams.has(native.stream)) {
        native.dispose();
        throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: random source reused a writer stream");
      }
      const state: WriterState = { native, heads: 0, disposed: false };
      const writer: Writer = Object.freeze({
        actor: native.actor, replica: native.replica,
        dispose: () => {
          if (state.disposed) return;
          this.#write(() => {
            if (state.heads) throw new EditorError("RESOURCE_IN_USE", "RESOURCE_IN_USE: heads still borrow this writer");
            state.disposed = true;
            native.dispose();
            this.#activeWriters.delete(state);
          });
        },
      });
      this.#streams.add(native.stream);
      this.#ownedStreams.add(native.stream);
      this.#writers.set(writer, state);
      this.#activeWriters.add(state);
      return writer;
    });
  }

  revisions(entries: readonly RevisionEntry[]): RevisionSet {
    this.#active();
    const unique = new Map<DocumentId, RevisionId>();
    for (const entry of entries) {
      const { document: rawDocument, revision } = entry;
      const document = documentId(rawDocument);
      this.#document(document).transactions(revision); // Existence, not just brand validation.
      const previous = unique.get(document);
      if (previous && previous !== revision) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: duplicate document has different revisions");
      }
      unique.set(document, revision);
    }
    const selected = [...unique].map(([document, revision]) => ({ document, revision }));
    assertGroupClosed(selected, this.#context());
    return revisionSet(selected);
  }

  #captureEntries(input: RevisionSet): readonly RevisionEntry[] {
    const iterate = input?.entries;
    if (typeof iterate !== "function") {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: expected an exact revision set, not a live head");
    }
    const entries: RevisionEntry[] = [];
    for (const entry of iterate.call(input)) {
      entries.push({ document: documentId(entry.document), revision: revisionId(entry.revision) });
    }
    return entries;
  }

  #capture(input: RevisionSet): RevisionSet { return this.revisions(this.#captureEntries(input)); }

  snapshot(input: RevisionEntry): TextSnapshot {
    const inner = this.#document(input.document).source(input.revision).snapshot();
    this.#snapshots++;
    let disposed = false;
    return Object.freeze({
      ...inner,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        inner.dispose();
        this.#snapshots--;
      },
    });
  }

  #headActive(state: HeadState): void {
    this.#active();
    if (state.disposed) throw new EditorError("DISPOSED", "DISPOSED: editing head has been released");
  }

  #member(state: HeadState, document: DocumentId): void {
    if (!state.checkpoint.revisions.has(document)) {
      throw new EditorError("DOCUMENT_NOT_IN_HEAD", "DOCUMENT_NOT_IN_HEAD: head membership is fixed");
    }
  }

  #expect(state: HeadState, expect: HeadCheckpoint): void {
    this.#headActive(state);
    if (!expect || expect.headId !== state.checkpoint.headId || expect.stamp !== state.checkpoint.stamp) {
      throw new EditorError("STALE_CHECKPOINT", "STALE_CHECKPOINT: head identity or ABA stamp changed");
    }
    const captured = this.#capture(expect.revisions);
    const current = [...state.checkpoint.revisions.entries()];
    if ([...captured.entries()].length !== current.length ||
      current.some((entry) => !captured.has(entry.document) || captured.get(entry.document) !== entry.revision)) {
      throw new EditorError("STALE_CHECKPOINT", "STALE_CHECKPOINT: checkpoint revisions do not match its stamp");
    }
  }

  fork(input: { at: RevisionSet; writer: Writer }): EditingHead {
    return this.#write(() => {
      const writer = this.#writers.get(input.writer);
      if (!writer) throw new EditorError("DIFFERENT_ATOMIC_DOMAIN", "DIFFERENT_ATOMIC_DOMAIN: writer belongs to another store");
      writer.native.assertActive();
      const revisions = this.#capture(input.at);
      const headId = `head:${this.#scope}:${++this.#localSerial}` as HeadId;
      const state: HeadState = {
        writer, stamp: 0n, disposed: false, listeners: new Set(),
        checkpoint: Object.freeze({ headId, stamp: "stamp:0" as HeadStamp, revisions }),
      };
      const head: EditingHead = Object.freeze({
        checkpoint: () => { this.#headActive(state); return state.checkpoint; },
        snapshot: (document: DocumentId) => {
          this.#headActive(state);
          this.#member(state, document);
          return this.snapshot({ document, revision: state.checkpoint.revisions.get(document) });
        },
        document: (document: DocumentId) => {
          this.#headActive(state);
          this.#member(state, document);
          return Object.freeze({ head, document });
        },
        commit: (input: Parameters<EditingHead["commit"]>[0]) => this.#write(() => this.#commit(state, input)),
        merge: (input: Parameters<EditingHead["merge"]>[0]) => this.#write(() => this.#move(state, input.expect, input.source, "merge")),
        checkout: (input: Parameters<EditingHead["checkout"]>[0]) => this.#write(() => this.#move(state, input.expect, input.at, "checkout")),
        onChange: (callback: (event: HeadChangeEvent) => void) => {
          this.#headActive(state);
          if (typeof callback !== "function") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: expected listener");
          const listener: Listener = { callback, active: true };
          state.listeners.add(listener);
          return Object.freeze({ dispose: () => { listener.active = false; state.listeners.delete(listener); } });
        },
        dispose: () => {
          if (state.disposed) return;
          this.#write(() => {
            state.disposed = true;
            for (const listener of state.listeners) listener.active = false;
            state.listeners.clear();
            writer.heads--;
            this.#heads.delete(state);
          });
        },
      });
      writer.heads++;
      this.#heads.add(state);
      return head;
    });
  }

  #commit(state: HeadState, input: Parameters<EditingHead["commit"]>[0]): CommitReceipt {
    this.#expect(state, input.expect);
    state.writer.native.assertActive();
    const meta = transactionMetadata({
      actor: state.writer.native.actor, replica: state.writer.native.replica,
      origin: input.origin, ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    });
    const byDocument = new Map<DocumentId, SourceEdit[]>();
    // All caller-owned values are detached before cloning a staging history.
    // No getter/iterator callback can then register a revision on an old owner
    // between the clone and publication.
    for (const rawEdit of input.edits) {
      const edit = canonicalCopy(rawEdit);
      this.#member(state, edit.document);
      if (edit.range.document !== edit.document || edit.range.revision !== state.checkpoint.revisions.get(edit.document)) {
        throw new EditorError("WRONG_REVISION", "WRONG_REVISION: edit source must match the expected head checkpoint");
      }
      const edits = byDocument.get(edit.document) ?? [];
      edits.push(edit);
      byDocument.set(edit.document, edits);
    }
    const drafts: { document: DocumentId; history: NativeHistory; draft: NativeDraft }[] = [];
    for (const [document, edits] of [...byDocument].sort(([a], [b]) => compareIds(a, b))) {
      const history = this.#document(document).clone();
      const draft = history.draft({ at: state.checkpoint.revisions.get(document), writer: state.writer.native, edits, ...meta });
      if (draft) drafts.push({ document, history, draft });
    }
    if (!drafts.length) return this.#receipt(state, state.checkpoint.revisions, [], [], "commit", meta.origin, false);
    const allocation = state.writer.native.plan(drafts.length);
    const manifest = createManifest(drafts.map(({ document, history, draft }, i) => ({
      document, base: history.root.base, root: history.root.id, transaction: allocation.ids[i]!,
      before: draft.transaction.depends, after: [allocation.ids[i]!],
    })));
    const documents = new Map(this.#documents);
    const owners = new Map(this.#transactionDocuments);
    const groups = new Map(this.#groups);
    this.#registerGroup(groups, manifest);
    const histories = drafts.map(({ document, history, draft }, i) => {
      const tx = history.finalize(draft, allocation.ids[i]!, manifest.id);
      this.#checkTransactionOwner(document, tx.id);
      history.accept([tx]);
      documents.set(document, history); owners.set(tx.id, document);
      return { document, root: history.root.id, transactions: [tx] };
    });
    const revisions = revisionSet([...state.checkpoint.revisions.entries()].map((entry) => {
      const member = manifest.members.find((item) => item.document === entry.document);
      return member ? { document: entry.document, revision: documents.get(entry.document)!.revision(member.after) } : entry;
    }));
    const target = [...revisions.entries()].map(({ document, revision }) => ({
      document, root: documents.get(document)!.root.id, frontier: documents.get(document)!.frontier(revision),
    }));
    historyBudget({ manifests: [manifest], histories, target }, histories.flatMap((history) => history.transactions));
    const context = this.#context(documents, groups, owners);
    validateGroups(context);
    assertGroupClosed([...revisions.entries()], context);
    // No caller callback or validation remains between consuming IDs and
    // publishing all document owners, the manifest, and the single checkpoint.
    state.writer.native.commit(allocation);
    for (const { document, history } of drafts) this.#documents.set(document, history);
    for (const member of manifest.members) this.#transactionDocuments.set(member.transaction, member.document);
    this.#groups.set(manifest.id, manifest);
    return this.#receipt(state, revisions, manifest.members.map((member) => member.document), allocation.ids, "commit", meta.origin, true);
  }

  #move(state: HeadState, expect: HeadCheckpoint, input: RevisionSet, reason: "merge" | "checkout"): CommitReceipt {
    this.#expect(state, expect);
    const captured = this.#capture(input);
    for (const entry of captured.entries()) this.#member(state, entry.document);
    const before = [...state.checkpoint.revisions.entries()];
    if (reason === "checkout" && [...captured.entries()].length !== before.length) {
      throw new EditorError("DOCUMENT_NOT_IN_HEAD", "DOCUMENT_NOT_IN_HEAD: checkout must preserve every head member");
    }
    const documents: DocumentId[] = [];
    const transactions: TransactionId[] = [];
    const staged = new Map(this.#documents);
    const next = before.map((entry) => {
      if (!captured.has(entry.document)) return entry;
      const history = reason === "merge" ? this.#document(entry.document).clone() : this.#document(entry.document);
      staged.set(entry.document, history);
      const revision = reason === "merge" ? history.join(entry.revision, captured.get(entry.document)) : captured.get(entry.document);
      if (revision !== entry.revision) {
        documents.push(entry.document);
        if (reason === "merge") {
          const old = new Set(history.transactions(entry.revision).map((tx) => tx.id));
          transactions.push(...history.transactions(revision).filter((tx) => !old.has(tx.id)).map((tx) => tx.id));
        }
      }
      return { document: entry.document, revision };
    });
    assertGroupClosed(next, this.#context(staged));
    for (const document of documents) this.#documents.set(document, staged.get(document)!);
    return this.#receipt(state, revisionSet(next), documents, transactions, reason, Object.freeze({ kind: reason }),
      documents.length > 0 || reason === "checkout");
  }

  #receipt(
    state: HeadState, revisions: RevisionSet, documents: readonly DocumentId[], transactions: readonly TransactionId[],
    reason: HeadChangeEvent["reason"], origin: HeadChangeEvent["origin"], publish: boolean,
  ): CommitReceipt {
    const before = state.checkpoint;
    const after = publish ? Object.freeze({
      headId: before.headId, stamp: `stamp:${++state.stamp}` as HeadStamp, revisions,
    }) : before;
    const receipt = Object.freeze({
      id: `commit:${this.#scope}:${++this.#localSerial}` as CommitId, before, after,
      documents: Object.freeze([...documents]), transactions: Object.freeze([...transactions]),
      groups: Object.freeze([...new Set(transactions.map((id) =>
        this.#document(this.#transactionDocuments.get(id)!).transaction(id).group))].sort(compareIds)),
      status: documents.length ? "committed" : "no-change",
    }) as CommitReceipt;
    state.checkpoint = after;
    this.#receipts.add(receipt);
    if (publish) this.#enqueue(state, Object.freeze({ change: receipt, reason, origin }));
    return receipt;
  }

  ownsReceipt(receipt: CommitReceipt): boolean { this.#active(); return this.#receipts.has(receipt); }

  #enqueue(state: HeadState, event: HeadChangeEvent): void {
    this.#events.push({ event, listeners: [...state.listeners] });
    if (this.#scheduled) return;
    this.#scheduled = true;
    void Promise.resolve().then(() => {
      this.#scheduled = false;
      const events = this.#events.splice(0);
      this.#notifying = true;
      try {
        for (const item of events) for (const listener of item.listeners) if (listener.active) {
          try { listener.callback(item.event); }
          catch (cause) { this.#report(cause); }
        }
      } finally { this.#notifying = false; }
    });
  }

  #report(cause: unknown): void {
    const error = cause instanceof EditorError ? cause :
      new EditorError("INVALID_REFERENCE", "Head listener failed after publication", { cause });
    if (this.#options.onError) {
      try { this.#options.onError(error); return; }
      catch (sinkError) { void Promise.resolve().then(() => { throw sinkError; }); return; }
    }
    // No silent default sink. Surface the error asynchronously without stopping
    // the remaining listeners or rolling back already published source state.
    void Promise.resolve().then(() => { throw error; });
  }

  #checkTransactionOwner(
    document: DocumentId, id: TransactionId, owners: ReadonlyMap<TransactionId, DocumentId> = this.#transactionDocuments,
  ): void {
    const previous = owners.get(id);
    if (previous !== undefined && previous !== document) {
      throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: transaction identity already belongs to another document");
    }
  }

  #checkScope(bundle: NativeHistoryBundle, documents?: readonly DocumentId[]): void {
    if (documents === undefined) return;
    const allowed = new Set(documents.map(documentId));
    const requested = new Set([
      ...bundle.histories.map((history) => history.document), ...bundle.target.map((target) => target.document),
      ...bundle.manifests.flatMap((manifest) => manifest.members.map((member) => member.document)),
    ]);
    const outside = [...requested].filter((document) => !allowed.has(document)).sort(compareIds);
    if (outside.length) throw new EditorError("SYNC_SCOPE_MISMATCH", "SYNC_SCOPE_MISMATCH: group transfer exceeds document domain", {
      details: { documents: outside },
    });
  }

  exportTyped(input: {
    target: RevisionSet; known?: RevisionSet; documents?: readonly DocumentId[];
  }): NativeHistoryBundle {
    this.#active();
    const target = this.#capture(input.target);
    const knownEntries = input.known === undefined ? [] : this.#captureEntries(input.known);
    const scope = input.documents === undefined ? undefined : canonicalCopy(input.documents);
    const known = new Map<DocumentId, Set<TransactionId>>();
    let verifiable = true;
    for (const entry of knownEntries) {
      const history = this.#documents.get(entry.document);
      try {
        if (!history) { verifiable = false; continue; }
        known.set(entry.document, new Set(history.transactions(entry.revision).map((tx) => tx.id)));
      } catch (cause) {
        if (!(cause instanceof EditorError) || cause.code !== "UNKNOWN_REVISION") throw cause;
        verifiable = false;
      }
    }
    // Unknown knowledge is not proof of possession; safely resend the exact
    // target closure. Fully verifiable knowledge must itself be group-closed.
    if (verifiable) this.revisions(knownEntries);
    else known.clear();
    const manifests = new Map<TransactionGroupId, NativeGroupManifest>();
    const histories = [...target.entries()].map(({ document, revision }) => {
      const history = this.#document(document);
      const transactions = history.transactions(revision);
      for (const tx of transactions) manifests.set(tx.group, this.group(tx.group));
      return {
        document, root: history.root.id,
        transactions: transactions.filter((tx) => !known.get(document)?.has(tx.id)),
      };
    });
    const bundle: NativeHistoryBundle = {
      manifests: [...manifests.values()].sort((a, b) => compareIds(a.id, b.id)), histories,
      target: [...target.entries()].map(({ document, revision }) => ({
        document, root: this.#document(document).root.id, frontier: this.#document(document).frontier(revision),
      })),
    };
    this.#checkScope(bundle, scope);
    historyBudget(bundle, histories.flatMap((history) => history.transactions));
    return canonicalCopy(bundle, MAX_HISTORY_BYTES);
  }

  acceptBundle(input: NativeHistoryBundle, options: { documents?: readonly DocumentId[] } = {}): NativeAcceptance {
    return this.#write(() => {
      const bundle = canonicalCopy(input, MAX_HISTORY_BYTES);
      const scope = options.documents === undefined ? undefined : canonicalCopy(options.documents);
      return this.#acceptBundle(bundle, scope);
    });
  }

  #acceptBundle(bundle: NativeHistoryBundle, scope?: readonly DocumentId[]): NativeAcceptance {
    this.#checkScope(bundle, scope);
    historyBudget(bundle, bundle.histories.flatMap((history) => history.transactions));
    const documents = new Map(this.#documents);
    const owners = new Map(this.#transactionDocuments);
    const groups = new Map(this.#groups);
    for (const input of bundle.manifests) {
      this.#registerGroup(groups, validateManifest(input));
    }
    const touched = new Set([...bundle.histories.map((history) => history.document), ...bundle.target.map((target) => target.document)]);
    for (const document of touched) documents.set(document, this.#document(document).clone());
    const seen = new Set<DocumentId>();
    let accepted = false;
    for (const input of bundle.histories) {
      const history = documents.get(input.document)!;
      if (seen.has(input.document)) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: duplicate bundle document");
      seen.add(input.document);
      if (history.root.id !== input.root) throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: typed history has another exact root");
      for (const tx of input.transactions) {
        checkTransactionId(tx.id);
        this.#checkTransactionOwner(input.document, tx.id, owners);
        if (this.#ownedStreams.has(tx.id.slice(2, 34)) && !this.#transactionDocuments.has(tx.id)) {
          throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: imported history cannot extend a locally leased writer stream");
        }
        owners.set(tx.id, input.document);
      }
      if (history.accept(input.transactions) === "accepted") accepted = true;
    }
    const selected = new Map<DocumentId, Set<TransactionId>>();
    const entries: RevisionEntry[] = [];
    const selectedGroups = new Set<TransactionGroupId>();
    for (const target of bundle.target) {
      const history = documents.get(target.document)!;
      if (selected.has(target.document)) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: duplicate target document");
      if (history.root.id !== target.root) throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: target has another exact root");
      for (const id of target.frontier) {
        checkTransactionId(id);
        if (!history.hasTransaction(id)) throw new EditorError("MISSING_DEPENDENCIES", "MISSING_DEPENDENCIES: target frontier is unavailable", {
          details: { document: target.document, missing: [id] },
        });
      }
      const revision = history.revision(target.frontier);
      const transactions = history.transactions(revision);
      selected.set(target.document, new Set(transactions.map((tx) => tx.id)));
      for (const tx of transactions) selectedGroups.add(tx.group);
      entries.push({ document: target.document, revision });
    }
    for (const input of bundle.histories) {
      if (!selected.has(input.document) || input.transactions.some((tx) => !selected.get(input.document)!.has(tx.id))) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: history payload is outside the declared exact target");
      }
    }
    const context = this.#context(documents, groups, owners);
    validateGroups(context);
    assertGroupClosed(entries, context);
    for (const manifest of bundle.manifests) if (!selectedGroups.has(manifest.id)) {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: manifest is outside the declared exact target");
    }
    // A single synchronous publication point; no head/checkpoint is moved.
    for (const document of touched) this.#documents.set(document, documents.get(document)!);
    for (const manifest of bundle.manifests) this.#groups.set(manifest.id, groups.get(manifest.id)!);
    for (const input of bundle.histories) for (const tx of input.transactions) {
      this.#transactionDocuments.set(tx.id, input.document);
      this.#streams.add(tx.id.slice(2, 34));
    }
    return Object.freeze({ status: accepted ? "accepted" : "duplicate", availableRevisions: revisionSet(entries) });
  }

  /** Compatibility convenience for standalone singleton transactions only. */
  accept(input: { document: DocumentId; transactions: readonly NativeTransaction[] }):
    Readonly<{ status: "accepted" | "duplicate"; at: RevisionEntry }> {
    return this.#write(() => {
      const { document, transactions } = canonicalCopy(input, MAX_HISTORY_BYTES);
      const history = this.#document(document);
      const manifests = new Map<TransactionGroupId, NativeGroupManifest>();
      for (const tx of transactions) {
        const manifest = createManifest([{
          document, base: history.root.base, root: history.root.id,
          transaction: tx.id, before: tx.depends, after: [tx.id],
        }]);
        if (manifest.id === tx.group) manifests.set(manifest.id, manifest);
      }
      const result = this.#acceptBundle({
        manifests: [...manifests.values()], histories: [{ document, root: history.root.id, transactions }],
        target: [{ document, root: history.root.id, frontier: transactions.map((tx) => tx.id) }],
      });
      return Object.freeze({ status: result.status, at: Object.freeze({ document, revision: result.availableRevisions.get(document) }) });
    });
  }

  #transactionInfo(id: TransactionId): TransactionInfo {
    this.#active();
    const document = this.#transactionDocuments.get(id);
    if (document === undefined) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown transaction");
    const history = this.#document(document);
    const tx = history.transaction(id);
    return Object.freeze({
      id, document, group: tx.group, dependencies: tx.depends,
      operations: Object.freeze(tx.effects.map((_, ordinal) => operationId(ordinalId(id, ordinal)))),
      actor: tx.actor, origin: tx.origin, ...(tx.attribution === undefined ? {} : { attribution: tx.attribution }),
      before: history.revision(tx.depends), after: history.revision([id]),
    });
  }

  #revisionInfo(entry: RevisionEntry): RevisionInfo {
    const { document, revision } = entry;
    const history = this.#document(document);
    const transactions = history.transactions(revision);
    const frontier = new Set(transactions.map((tx) => tx.id));
    for (const tx of transactions) for (const dependency of tx.depends) frontier.delete(dependency);
    const sorted = [...frontier].sort(compareIds);
    return Object.freeze({
      document, revision, base: history.root.base, frontier: Object.freeze(sorted),
      // Determined by the causal set, not which merge invocation first created
      // this revision: remove each maximal transaction in canonical ID order.
      parents: Object.freeze(sorted.map((id) => history.revision(transactions.filter((tx) => tx.id !== id).map((tx) => tx.id)))),
    });
  }

  #page(input: Parameters<HistoryQueries["transactions"]>[0]): HistoryPage {
    const history = this.#document(input.document);
    const ordered = history.transactions(input.includedIn);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new EditorError("INVALID_RANGE", "INVALID_RANGE: history page limit must be a positive safe integer");
    }
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = this.#cursors.get(input.cursor);
      if (!cursor) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown history cursor");
      if (cursor.document !== input.document || cursor.revision !== input.includedIn) {
        throw new EditorError("WRONG_REVISION", "WRONG_REVISION: cursor belongs to another exact history query");
      }
      offset = cursor.offset;
    }
    const selected = ordered.slice(offset, offset + input.limit);
    const nextOffset = offset + selected.length;
    let next: HistoryCursor | null = null;
    if (nextOffset < ordered.length) {
      next = `cursor:${this.#scope}:${++this.#localSerial}` as HistoryCursor;
      this.#cursors.set(next, Object.freeze({ document: input.document, revision: input.includedIn, offset: nextOffset }));
    }
    return Object.freeze({ items: Object.freeze(selected.map((tx) => this.#transactionInfo(tx.id))), next });
  }

  #provenance(input: Parameters<HistoryQueries["provenance"]>[0]): readonly ProvenanceSpan[] {
    const history = this.#document(input.document);
    const elements = history.elements(input.revision).filter((element) => element.visible);
    if (input.range.document !== input.document || input.range.revision !== input.revision) {
      throw new EditorError("WRONG_REVISION", "WRONG_REVISION: provenance range belongs to another source");
    }
    const index = new TextIndex(history.text(input.revision));
    const low = index.scalarAt(input.range.start, input.range.unit);
    const high = index.scalarAt(input.range.end, input.range.unit);
    if (high < low) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: reversed provenance range");
    const spans: ProvenanceSpan[] = [];
    for (let start = low; start < high;) {
      const element = elements[start]!;
      let end = start + 1;
      while (end < high && elements[end]!.transaction === element.transaction) end++;
      const attribution = element.transaction === null ? undefined : history.transaction(element.transaction).attribution;
      spans.push(Object.freeze({
        range: Object.freeze({
          document: input.document, revision: input.revision, unit: "utf16" as const,
          start: index.offsetAt(start, "utf16"), end: index.offsetAt(end, "utf16"),
        }),
        transaction: element.transaction, actor: element.actor, ...(attribution === undefined ? {} : { attribution }),
      }));
      start = end;
    }
    return Object.freeze(spans);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#write(() => {
      if (this.#heads.size || this.#activeWriters.size || this.#snapshots) {
        throw new EditorError("RESOURCE_IN_USE", "RESOURCE_IN_USE: release heads, writers and snapshots before their store");
      }
      this.#disposed = true;
      this.#documents.clear();
      this.#transactionDocuments.clear();
      this.#groups.clear();
      this.#streams.clear();
      this.#ownedStreams.clear();
      this.#cursors.clear();
      this.#events.length = 0;
    });
  }
}
