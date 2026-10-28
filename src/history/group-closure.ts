import type { RevisionEntry } from "../contracts/core.js";
import { EditorError } from "../errors.js";
import type { DocumentId, TransactionGroupId, TransactionId } from "../identity.js";
import { canonicalJson } from "./canonical.js";
import type { NativeHistory } from "./native-history.js";
import { compareIds } from "./sequence.js";
import type { NativeGroupManifest, NativeGroupMember } from "./transaction-group.js";

export interface GroupContext {
  readonly documents: ReadonlyMap<DocumentId, NativeHistory>;
  readonly groups: ReadonlyMap<TransactionGroupId, NativeGroupManifest>;
  readonly owners: ReadonlyMap<TransactionId, DocumentId>;
}

function membership(context: GroupContext): ReadonlyMap<TransactionId, Readonly<{ group: NativeGroupManifest; member: NativeGroupMember }>> {
  const index = new Map<TransactionId, Readonly<{ group: NativeGroupManifest; member: NativeGroupMember }>>();
  for (const group of context.groups.values()) for (const member of group.members) {
    if (index.has(member.transaction)) {
      throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: transaction claimed by multiple group manifests");
    }
    index.set(member.transaction, { group, member });
  }
  return index;
}

/** Manifest/root/payload binding and the cross-document group dependency DAG. */
export function validateGroups(context: GroupContext): void {
  const members = membership(context);
  const dependencies = new Map<TransactionGroupId, Set<TransactionGroupId>>();
  for (const group of context.groups.values()) {
    const edges = new Set<TransactionGroupId>();
    for (const member of group.members) {
      const history = context.documents.get(member.document);
      // An omitted member may also need exact root registration. Let closure
      // report that requirement, rather than implicitly creating the document.
      if (!history) continue;
      if (history.root.id !== member.root || history.root.base !== member.base) {
        throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: manifest member has another exact root/base");
      }
      const owner = context.owners.get(member.transaction);
      if (owner !== undefined && owner !== member.document) {
        throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: manifest transaction belongs to another document");
      }
      if (history.hasTransaction(member.transaction)) {
        const tx = history.transaction(member.transaction);
        if (tx.group !== group.id) throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: transaction membership differs");
        if (canonicalJson(tx.depends) !== canonicalJson(member.before)) {
          throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: manifest before differs from transaction base");
        }
      }
      for (const id of member.before) {
        const dependency = members.get(id);
        if (dependency && dependency.member.document !== member.document) {
          throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: manifest before references another document");
        }
        if (dependency) edges.add(dependency.group.id);
      }
    }
    dependencies.set(group.id, edges);
  }
  // Per-document acyclicity alone is insufficient: two otherwise valid graphs
  // can form G1 -> G2 in one source and G2 -> G1 in another.
  const counts = new Map<TransactionGroupId, number>();
  const children = new Map<TransactionGroupId, TransactionGroupId[]>();
  const ready: TransactionGroupId[] = [];
  for (const [id, edges] of dependencies) {
    counts.set(id, edges.size);
    if (!edges.size) ready.push(id);
    for (const dependency of edges) {
      const list = children.get(dependency) ?? [];
      list.push(id); children.set(dependency, list);
    }
  }
  let visited = 0;
  while (ready.length) {
    const id = ready.pop()!;
    visited++;
    for (const child of children.get(id) ?? []) {
      const count = counts.get(child)! - 1;
      counts.set(child, count);
      if (!count) ready.push(child);
    }
  }
  if (visited !== dependencies.size) {
    throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: cross-document group dependency cycle");
  }
  for (const group of context.groups.values()) {
    // In a group writing A and B, observing an ancestor group's A member also
    // requires observing its B member BEFORE writing B. A final merged target
    // cannot retroactively repair inconsistent member bases. Read-only sources
    // need not become write members; closure requests them separately.
    if (group.members.some((member) => !context.documents.get(member.document)?.hasTransaction(member.transaction))) continue;
    const bases = new Map(group.members.map((member) => [
      member.document, new Set(context.documents.get(member.document)!.closure(member.before).map((tx) => tx.id)),
    ]));
    const pending = [...dependencies.get(group.id)!];
    const ancestors = new Set<TransactionGroupId>();
    while (pending.length) {
      const id = pending.pop()!;
      if (ancestors.has(id)) continue;
      ancestors.add(id);
      const ancestor = context.groups.get(id)!;
      for (const member of ancestor.members) {
        if (bases.has(member.document) && !bases.get(member.document)!.has(member.transaction)) {
          throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: group members have inconsistent causal bases");
        }
      }
      for (const dependency of dependencies.get(id)!) pending.push(dependency);
    }
  }
}

/**
 * One rule for all version/transport boundaries. Requirements refer to exact
 * member IDs/frontiers, not a live head or a "latest" document revision.
 */
export function assertGroupClosed(entries: readonly RevisionEntry[], context: GroupContext): void {
  const members = membership(context);
  const selected = new Map<DocumentId, Set<TransactionId>>();
  const queue: { document: DocumentId; transaction: TransactionId }[] = [];
  for (const entry of entries) {
    const history = context.documents.get(entry.document);
    if (!history) throw new EditorError("UNKNOWN_DOCUMENT", "UNKNOWN_DOCUMENT: group closure document was not registered");
    const transactions = history.transactions(entry.revision);
    selected.set(entry.document, new Set(transactions.map((tx) => tx.id)));
    for (const tx of transactions) queue.push({ document: entry.document, transaction: tx.id });
  }
  const visited = new Set<TransactionId>();
  const groups = new Set<TransactionGroupId>();
  const missing = new Map<TransactionGroupId, NativeGroupMember[]>();
  const manifests = new Set<TransactionGroupId>();
  while (queue.length) {
    const ref = queue.pop()!;
    if (visited.has(ref.transaction)) continue;
    visited.add(ref.transaction);
    const history = context.documents.get(ref.document);
    const tx = history?.hasTransaction(ref.transaction) ? history.transaction(ref.transaction) : undefined;
    const declared = members.get(ref.transaction);
    if (declared && declared.member.document !== ref.document) {
      throw new EditorError("INVALID_CAUSAL_GRAPH", "INVALID_CAUSAL_GRAPH: group ancestor belongs to another document");
    }
    if (tx) for (const dependency of tx.depends) queue.push({ document: ref.document, transaction: dependency });
    const group = tx ? context.groups.get(tx.group) : declared?.group;
    if (!group) { if (tx) manifests.add(tx.group); continue; }
    if (tx && (!declared || declared.group.id !== tx.group)) {
      throw new EditorError("IDENTITY_CONFLICT", "IDENTITY_CONFLICT: transaction absent from its manifest");
    }
    if (groups.has(group.id)) continue;
    groups.add(group.id);
    const required: NativeGroupMember[] = [];
    for (const member of group.members) {
      if (!selected.get(member.document)?.has(member.transaction)) required.push(member);
      queue.push({ document: member.document, transaction: member.transaction });
      // Follow known before ancestors even when the required member payload is
      // absent; this reports transitive requirements without moving any source.
      for (const dependency of member.before) queue.push({ document: member.document, transaction: dependency });
    }
    if (required.length) missing.set(group.id, required);
  }
  if (missing.size || manifests.size) {
    throw new EditorError("INCOMPLETE_TRANSACTION_GROUP", "INCOMPLETE_TRANSACTION_GROUP: exact group members are required", {
      details: {
        missing: [...missing].sort(([a], [b]) => compareIds(a, b))
          .flatMap(([group, members]) => members.map((member) => ({ group, ...member }))),
        missingManifests: [...manifests].sort(compareIds),
      },
    });
  }
}
