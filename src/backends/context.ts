import type {
  CommitReceipt, HeadCheckpoint, HistoryBundle, PositionToken, RevisionEntry, RevisionSet, StablePosition,
} from "../contracts/core.js";
import type {
  HistoryBackendContext, HistoryBackendDescriptor, HistoryBackendIdentities, HistoryBackendProtocol, HistoryCommitData,
  HistoryIdentityKinds, HistoryOpaqueStore, HistoryUndoToken,
} from "../contracts/history-backend.js";
import { EditorError } from "../errors.js";
import { documentId, historyBackendId, revisionId, type DocumentId, type RevisionId } from "../identity.js";

type Kind = "position" | "positionToken" | "bundle" | "undo" | "receipt";
interface ValueRecord {
  readonly namespace: string;
  readonly format: string;
  readonly owner: object;
  readonly issuer: object;
  readonly kind: Kind;
  readonly payload: unknown;
}
// Opaque in-process values only. This registry is neither serialization nor authentication.
const values = new WeakMap<object, ValueRecord>();

function protocolText(value: string): string {
  historyBackendId(value);
  let bytes = 0;
  for (const scalar of value) {
    const cp = scalar.codePointAt(0)!;
    bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4;
  }
  if (bytes > 128) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: backend protocol identifiers are limited to 128 UTF-8 bytes");
  return value;
}

export function captureDescriptor(input: HistoryBackendDescriptor): HistoryBackendDescriptor {
  if (!input || typeof input !== "object") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: backend descriptor is required");
  const { id, contractVersion, algorithm, formats, capabilities } = input;
  if (contractVersion !== 1) throw new EditorError("UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT: history backend contract version");
  if (!formats || !capabilities) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: backend formats and capabilities are required");
  const { selectiveUndo, deferredImport } = capabilities;
  if (typeof selectiveUndo !== "boolean" || typeof deferredImport !== "boolean") {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: explicit backend capabilities are required");
  }
  return Object.freeze({
    id: historyBackendId(protocolText(id)), contractVersion,
    algorithm: protocolText(algorithm),
    formats: Object.freeze({ history: protocolText(formats.history), position: protocolText(formats.position) }),
    capabilities: Object.freeze({ selectiveUndo, deferredImport }),
  });
}

export function captureProtocol(input: HistoryBackendProtocol): HistoryBackendProtocol {
  const { backend, contractVersion, algorithm, format } = input;
  if (contractVersion !== 1) throw new EditorError("UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT: history backend contract version");
  return Object.freeze({
    backend: historyBackendId(protocolText(backend)), contractVersion,
    algorithm: protocolText(algorithm), format: protocolText(format),
  });
}

export interface BackendContextState {
  readonly api: HistoryBackendContext;
  check(value: object, kind: Kind): void;
  set(input: RevisionSet): RevisionSet;
  entries(input: Iterable<RevisionEntry>): RevisionSet;
  checkpoint(input: HeadCheckpoint): HeadCheckpoint;
}

export function makeContext(descriptor: HistoryBackendDescriptor): BackendContextState {
  // Length-safe escaping makes IDs injective without hashing or importing the
  // native CRDT, rope, canonical JSON or a platform crypto implementation.
  const namespace = `hb1:${encodeURIComponent(descriptor.id)}:${encodeURIComponent(descriptor.algorithm)}:`;
  const owner = Object.freeze({});
  const kinds = new Set<keyof HistoryIdentityKinds>(["revision", "transaction", "operation", "group", "head", "stamp", "commit", "cursor"]);
  const identities: HistoryBackendIdentities = Object.freeze({
    create<K extends keyof HistoryIdentityKinds>(kind: K, local: string): HistoryIdentityKinds[K] {
      if (!kinds.has(kind)) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown backend identity kind");
      revisionId(local);
      return revisionId(`${namespace}${kind}:${local}`) as unknown as HistoryIdentityKinds[K];
    },
    local<K extends keyof HistoryIdentityKinds>(kind: K, value: HistoryIdentityKinds[K]): string {
      revisionId(value);
      const prefix = `${namespace}${kind}:`;
      if (!kinds.has(kind) || !value.startsWith(prefix)) {
        throw new EditorError("DIFFERENT_ATOMIC_DOMAIN", "DIFFERENT_ATOMIC_DOMAIN: identity belongs to another backend or kind");
      }
      const local = value.slice(prefix.length);
      revisionId(local);
      return local;
    },
  });
  const format = (kind: Kind): string =>
    kind === "bundle" ? descriptor.formats.history : kind === "positionToken" ? descriptor.formats.position : "";
  const portable = (kind: Kind): boolean => kind === "bundle" || kind === "positionToken";
  const record = (value: unknown): ValueRecord | undefined =>
    value !== null && typeof value === "object" ? values.get(value) : undefined;
  const compatible = (value: ValueRecord | undefined, kind: Kind): boolean =>
    value?.namespace === namespace && value.kind === kind && value.format === format(kind) &&
    (portable(kind) || value.owner === owner);
  const check = (value: object, kind: Kind): void => {
    if (!compatible(record(value), kind)) throw new EditorError(
      portable(kind) ? "UNSUPPORTED_FORMAT" : "INVALID_REFERENCE",
      `${portable(kind) ? "UNSUPPORTED_FORMAT" : "INVALID_REFERENCE"}: foreign, incompatible or forged ${kind}`,
    );
  };
  const opaque = <Token extends object, Payload>(kind: Kind): HistoryOpaqueStore<Token, Payload> => {
    const issuer = Object.freeze({});
    const has = (value: unknown): value is Token => {
      const found = record(value);
      return compatible(found, kind) && (portable(kind) || found!.issuer === issuer);
    };
    return Object.freeze({
      create(payload: Payload): Token {
        const token = Object.freeze({}) as Token;
        values.set(token, { namespace, format: format(kind), owner, issuer, kind, payload });
        return token;
      },
      read(token: Token): Payload {
        if (!has(token)) throw new EditorError(portable(kind) ? "UNSUPPORTED_FORMAT" : "INVALID_REFERENCE",
          `${portable(kind) ? "UNSUPPORTED_FORMAT" : "INVALID_REFERENCE"}: opaque value is not readable by this backend scope`);
        return record(token)!.payload as Payload;
      },
      has,
    });
  };
  const entries = (input: Iterable<RevisionEntry>): RevisionSet => {
    const entries = new Map<DocumentId, RevisionId>();
    for (const raw of input) {
      const { document, revision } = raw;
      documentId(document); identities.local("revision", revision);
      if (entries.has(document) && entries.get(document) !== revision) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: conflicting duplicate revision-set document");
      }
      entries.set(document, revision);
    }
    const sorted = Object.freeze([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([document, revision]) => Object.freeze({ document, revision })));
    return Object.freeze({
      get(document: DocumentId): RevisionId {
        const revision = entries.get(document);
        if (revision === undefined) throw new EditorError("UNKNOWN_DOCUMENT", "UNKNOWN_DOCUMENT: document absent from revision set");
        return revision;
      },
      has: (document: DocumentId) => entries.has(document), entries: () => sorted.values(),
    });
  };
  const set = (input: RevisionSet): RevisionSet => entries(input.entries());
  const checkpoint = (input: HeadCheckpoint): HeadCheckpoint => {
    const { headId, stamp, revisions } = input;
    identities.local("head", headId); identities.local("stamp", stamp);
    return Object.freeze({ headId, stamp, revisions: set(revisions) });
  };
  const api: HistoryBackendContext = Object.freeze({
    descriptor, identities,
    positions: <Payload>(): HistoryOpaqueStore<StablePosition, Payload> => opaque("position"),
    positionTokens: <Payload>(): HistoryOpaqueStore<PositionToken, Payload> => opaque("positionToken"),
    bundles: <Payload>(): HistoryOpaqueStore<HistoryBundle, Payload> => opaque("bundle"),
    undoTokens: <Payload>(): HistoryOpaqueStore<HistoryUndoToken, Payload> => opaque("undo"),
    issueReceipt<T extends HistoryCommitData>(input: T): CommitReceipt & Omit<T, keyof HistoryCommitData> {
      identities.local("commit", input.id);
      input.transactions.forEach((id) => identities.local("transaction", id));
      input.groups.forEach((id) => identities.local("group", id));
      const receipt = Object.freeze({
        ...input, before: checkpoint(input.before), after: checkpoint(input.after),
        documents: Object.freeze([...input.documents]), transactions: Object.freeze([...input.transactions]), groups: Object.freeze([...input.groups]),
      }) as unknown as CommitReceipt & Omit<T, keyof HistoryCommitData>;
      values.set(receipt, { namespace, format: "", owner, issuer: owner, kind: "receipt", payload: undefined });
      return receipt;
    },
  });
  return { api, check, set, entries, checkpoint };
}
