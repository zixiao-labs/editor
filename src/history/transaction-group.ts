import { EditorError } from "../errors.js";
import {
  documentId, externalBaseId, transactionGroupId, type DocumentId, type ExternalBaseId,
  type TransactionGroupId, type TransactionId,
} from "../identity.js";
import { canonicalCopy, canonicalJson, framedDigest } from "./canonical.js";
import { checkTransactionId } from "./identity.js";
import type { NativeTransaction } from "./native-history.js";
import { compareIds } from "./sequence.js";

export const MAX_HISTORY_BYTES: number = 8 * 1024 * 1024;
export const MAX_HISTORY_OPERATIONS: number = 100_000;
export interface NativeGroupMember {
  readonly document: DocumentId;
  readonly base: ExternalBaseId;
  readonly root: string;
  readonly transaction: TransactionId;
  readonly before: readonly TransactionId[];
  readonly after: readonly TransactionId[];
}
/** Internal typed manifest, not a versioned wire format or an authorization token. */
export interface NativeGroupManifest {
  readonly id: TransactionGroupId;
  readonly members: readonly NativeGroupMember[];
}

export function checkGroupId(id: TransactionGroupId): void {
  if (typeof id !== "string" || !/^group:[0-9a-f]{64}$/.test(id)) {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: noncanonical transaction group identity");
  }
}

export function createManifest(input: readonly NativeGroupMember[]): NativeGroupManifest {
  if (!input.length) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: empty transaction group");
  const members = canonicalCopy(input).slice().sort((a, b) => compareIds(a.document, b.document));
  const transactions = new Set<TransactionId>();
  for (let i = 0; i < members.length; i++) {
    const member = members[i]!;
    documentId(member.document); externalBaseId(member.base); checkTransactionId(member.transaction);
    if (!/^root:[0-9a-f]{64}$/.test(member.root) || (i && members[i - 1]!.document === member.document) ||
      transactions.has(member.transaction)) {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: duplicate or malformed group member");
    }
    transactions.add(member.transaction);
    if (!Array.isArray(member.before) || !Array.isArray(member.after) ||
      member.after.length !== 1 || member.after[0] !== member.transaction) {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid group before/after frontiers");
    }
    for (let j = 0; j < member.before.length; j++) {
      checkTransactionId(member.before[j]!);
      if (j && compareIds(member.before[j - 1]!, member.before[j]!) >= 0) {
        throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: noncanonical group before frontier");
      }
    }
  }
  // IDs precede the digest. No transaction payload, group reference or revision
  // digest is hashed into itself; the transaction's group field binds membership.
  const id = transactionGroupId(`group:${framedDigest("editor/group/v1", [canonicalJson(members)])}`);
  return Object.freeze({ id, members: Object.freeze(members) });
}

export function validateManifest(input: NativeGroupManifest): NativeGroupManifest {
  checkGroupId(input.id);
  const manifest = createManifest(input.members);
  if (manifest.id !== input.id || canonicalJson(manifest) !== canonicalJson(input)) {
    throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: manifest identity, order or payload differs");
  }
  return manifest;
}

/** One budget for the ENTIRE typed batch, including manifests and target refs. */
export function historyBudget(envelope: unknown, transactions: readonly NativeTransaction[]): void {
  let operations = 0;
  for (const tx of transactions) {
    if (!Array.isArray(tx.effects)) throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: malformed effects");
    for (const effect of tx.effects) {
      if (effect.kind === "delete" && Array.isArray(effect.targets)) operations += effect.targets.length;
      else if (effect.kind === "insert") operations++;
      else throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: malformed effect");
      if (operations > MAX_HISTORY_OPERATIONS) {
        throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: transaction group operations");
      }
    }
  }
  canonicalJson(envelope, MAX_HISTORY_BYTES);
}
