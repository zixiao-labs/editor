import { EditorError } from "./errors.js";

declare const identity: unique symbol;
export type Opaque<Value, Name extends string> = Value & { readonly [identity]: Name };

export type DocumentId = Opaque<string, "DocumentId">;
export type ExternalBaseId = Opaque<string, "ExternalBaseId">;
export type RevisionId = Opaque<string, "RevisionId">;
export type ActorId = Opaque<string, "ActorId">;
export type ReplicaId = Opaque<string, "ReplicaId">;
export type TransactionId = Opaque<string, "TransactionId">;
export type OperationId = Opaque<string, "OperationId">;
export type TransactionGroupId = Opaque<string, "TransactionGroupId">;
export type SelectionId = Opaque<string, "SelectionId">;
export type ExcerptId = Opaque<string, "ExcerptId">;
export type HeadId = Opaque<string, "HeadId">;
export type HeadStamp = Opaque<string, "HeadStamp">;
export type SelectionVersion = Opaque<string, "SelectionVersion">;
export type ProjectionVersion = Opaque<string, "ProjectionVersion">;
export type CommitId = Opaque<string, "CommitId">;
export type UndoGroupId = Opaque<string, "UndoGroupId">;
export type HistoryCursor = Opaque<string, "HistoryCursor">;
export type PresenceScopeId = Opaque<string, "PresenceScopeId">;
export type HistoryBackendId = Opaque<string, "HistoryBackendId">;
export type HistoryPendingId = Opaque<string, "HistoryPendingId">;

function checked<Name extends string>(input: string): Opaque<string, Name> {
  if (typeof input !== "string" || !input.length || /[\u0000-\u001f\u007f-\u009f]/u.test(input)) {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: identity must be a nonempty control-free string");
  }
  let bytes = 0;
  for (const scalar of input) {
    const code = scalar.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new EditorError("INVALID_UNICODE", "INVALID_UNICODE: identity contains an unpaired surrogate");
    }
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  if (bytes > 1024) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: identity exceeds 1024 UTF-8 bytes");
  return input as Opaque<string, Name>;
}

// Validation does not authenticate an identity or prove that its history exists.
export const documentId = (value: string): DocumentId => checked(value);
export const externalBaseId = (value: string): ExternalBaseId => checked(value);
export const revisionId = (value: string): RevisionId => checked(value);
export const actorId = (value: string): ActorId => checked(value);
export const replicaId = (value: string): ReplicaId => checked(value);
export const transactionId = (value: string): TransactionId => checked(value);
export const operationId = (value: string): OperationId => checked(value);
export const transactionGroupId = (value: string): TransactionGroupId => checked(value);
export const selectionId = (value: string): SelectionId => checked(value);
export const excerptId = (value: string): ExcerptId => checked(value);
export const presenceScopeId = (value: string): PresenceScopeId => checked(value);
export const historyBackendId = (value: string): HistoryBackendId => checked(value);
export const historyPendingId = (value: string): HistoryPendingId => checked(value);
