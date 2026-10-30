import type { RandomSource, Writer } from "../contracts/core.js";
import { EditorError } from "../errors.js";
import {
  actorId, documentId, externalBaseId, replicaId, transactionId,
  type ActorId, type DocumentId, type ExternalBaseId, type ReplicaId, type TransactionId,
} from "../identity.js";
import { framedDigest } from "./canonical.js";

export interface RootRegistration {
  readonly id: string;
  readonly document: DocumentId;
  readonly base: ExternalBaseId;
  readonly text: string;
}

export function createRoot(input: Omit<RootRegistration, "id">): RootRegistration {
  const document = documentId(input.document);
  const base = externalBaseId(input.base);
  return Object.freeze({
    document, base, text: input.text,
    id: `root:${framedDigest("editor/root/v1", [document, base, input.text])}`,
  });
}

export function checkTransactionId(id: TransactionId): void {
  if (typeof id !== "string" || !/^t:[0-9a-f]{32}:[0-9a-f]{16}$/.test(id) || id.endsWith(":0000000000000000")) {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: noncanonical stream/counter identity");
  }
}

export function checkRootId(id: string): void {
  if (typeof id !== "string" || !/^root:[0-9a-f]{64}$/.test(id)) {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: noncanonical root identity");
  }
}

const ELEMENT_ID = /^(?:t:[0-9a-f]{32}:[0-9a-f]{16}|root:[0-9a-f]{64})\/[0-9a-f]{8}$/u;

export function checkElementId(id: string): void {
  if (typeof id !== "string" || !ELEMENT_ID.test(id)) {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: noncanonical element identity");
  }
}

export interface NativeAllocation { readonly ids: readonly TransactionId[] }

/** One non-resumable stream. Counter ordering is never a dependency relation. */
export class NativeWriter implements Writer {
  readonly actor: ActorId;
  readonly replica: ReplicaId;
  readonly #stream: string;
  #counter = 0n;
  #disposed = false;
  readonly #allocations = new WeakMap<NativeAllocation, Readonly<{ before: bigint; after: bigint }>>();

  constructor(input: { actor: ActorId; replica: ReplicaId; random?: RandomSource }) {
    this.actor = actorId(input.actor);
    this.replica = replicaId(input.replica);
    const bytes = new Uint8Array(16);
    try {
      if (input.random) input.random.fill(bytes);
      else {
        const crypto = (globalThis as { crypto?: { getRandomValues(bytes: Uint8Array): unknown } }).crypto;
        if (!crypto) throw new Error("No secure random source");
        crypto.getRandomValues(bytes);
      }
      this.#stream = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch (cause) {
      throw new EditorError("RANDOM_UNAVAILABLE", "RANDOM_UNAVAILABLE: writer requires 128 secure random bits", { cause });
    }
    Object.freeze(this);
  }

  get stream(): string { return this.#stream; }

  assertActive(): void {
    if (this.#disposed) throw new EditorError("DISPOSED", "DISPOSED: writer has been released");
  }

  /** Tentative IDs; validation can fail without rewinding or consuming this stream. */
  plan(count: number): NativeAllocation {
    this.assertActive();
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new EditorError("INVALID_RANGE", "INVALID_RANGE: allocation count must be a positive safe integer");
    }
    const after = this.#counter + BigInt(count);
    if (after > 0xffffffffffffffffn) {
      throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: writer counter exhausted; open a new stream");
    }
    const ids = Array.from({ length: count }, (_, i) =>
      transactionId(`t:${this.#stream}:${(this.#counter + BigInt(i) + 1n).toString(16).padStart(16, "0")}`));
    const allocation = Object.freeze({ ids: Object.freeze(ids) });
    this.#allocations.set(allocation, Object.freeze({ before: this.#counter, after }));
    return allocation;
  }

  commit(allocation: NativeAllocation): void {
    this.assertActive();
    const planned = this.#allocations.get(allocation);
    if (!planned || planned.before !== this.#counter) {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: stale or foreign writer allocation");
    }
    this.#counter = planned.after;
    this.#allocations.delete(allocation);
  }

  allocate(): TransactionId {
    const allocation = this.plan(1);
    this.commit(allocation);
    return allocation.ids[0]!;
  }

  dispose(): void { this.#disposed = true; }
}
