import type {
  CommitReceipt, Disposable, EditingHead, HeadCheckpoint, HistoryBundle, HistoryStore, HistoryStoreOptions,
  PositionToken, StablePosition,
} from "./core.js";
import type {
  CommitId, HeadId, HeadStamp, HistoryBackendId, HistoryCursor, Opaque, OperationId, RevisionId,
  TransactionGroupId, TransactionId,
} from "../identity.js";

/** These describe a semantic protocol family, not a package name or authorization principal. */
export interface HistoryBackendDescriptor {
  readonly id: HistoryBackendId;
  readonly contractVersion: 1;
  /** Include the ordering/revision-identity semantics version. */
  readonly algorithm: string;
  readonly formats: Readonly<{ history: string; position: string }>;
  readonly capabilities: Readonly<{ selectiveUndo: boolean; deferredImport: boolean }>;
}
/** Transport offers need only the protocol for the selected operation, not peer-local capabilities. */
export interface HistoryBackendProtocol {
  readonly backend: HistoryBackendId;
  readonly contractVersion: 1;
  readonly algorithm: string;
  readonly format: string;
}
export type HistoryUndoToken = Opaque<object, "HistoryUndoToken">;
export interface HistoryUndoChange {
  readonly status: "applied" | "partial" | "no-effect";
  readonly change: CommitReceipt;
}
/** Backend effects only; selection restoration, grouping and stack policy belong to sessions. */
export interface HistoryUndoScope extends Disposable {
  capture(input: { change: CommitReceipt }): HistoryUndoToken;
  apply(input: {
    expect: HeadCheckpoint; tokens: readonly HistoryUndoToken[]; direction: "undo" | "redo";
  }): HistoryUndoChange;
}
export interface HistoryUndoProvider {
  open(input: { head: EditingHead }): HistoryUndoScope;
}
export interface HistoryIdentityKinds {
  readonly revision: RevisionId;
  readonly transaction: TransactionId;
  readonly operation: OperationId;
  readonly group: TransactionGroupId;
  readonly head: HeadId;
  readonly stamp: HeadStamp;
  readonly commit: CommitId;
  readonly cursor: HistoryCursor;
}
export interface HistoryBackendIdentities {
  create<K extends keyof HistoryIdentityKinds>(kind: K, local: string): HistoryIdentityKinds[K];
  local<K extends keyof HistoryIdentityKinds>(kind: K, id: HistoryIdentityKinds[K]): string;
}
export interface HistoryOpaqueStore<Token extends object, Payload> {
  create(payload: Payload): Token;
  read(token: Token): Payload;
  has(value: unknown): value is Token;
}
export type HistoryCommitData = Pick<CommitReceipt,
  "id" | "before" | "after" | "documents" | "transactions" | "groups" | "status">;
/** Trusted adapter SDK. Payload validation and actual CRDT semantics remain the provider's responsibility. */
export interface HistoryBackendContext {
  readonly descriptor: HistoryBackendDescriptor;
  readonly identities: HistoryBackendIdentities;
  positions<Payload>(): HistoryOpaqueStore<StablePosition, Payload>;
  positionTokens<Payload>(): HistoryOpaqueStore<PositionToken, Payload>;
  bundles<Payload>(): HistoryOpaqueStore<HistoryBundle, Payload>;
  undoTokens<Payload>(): HistoryOpaqueStore<HistoryUndoToken, Payload>;
  issueReceipt<T extends HistoryCommitData>(input: T): CommitReceipt & Omit<T, keyof HistoryCommitData>;
}
/** Every required HistoryStore method must be implemented; no partial-native-store cast. */
export type HistoryStoreImplementation = Omit<HistoryStore, "backend">;
export interface HistoryBackendDefinition {
  readonly descriptor: HistoryBackendDescriptor;
  createStore(context: HistoryBackendContext, options: HistoryStoreOptions): HistoryStoreImplementation;
}
export interface HistoryBackend {
  readonly descriptor: HistoryBackendDescriptor;
  createStore(options?: HistoryStoreOptions): HistoryStore;
}
