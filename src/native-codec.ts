import type { HistoryBundle, PositionToken } from "./contracts/core.js";
import { scalarUtf8Length } from "./coordinates/text-index.js";
import { EditorError } from "./errors.js";
import { decodeUtf8Strict } from "./history/bytes.js";
import { canonicalCopy, canonicalJson, utf8 } from "./history/canonical.js";
import { checkElementId, checkRootId, checkTransactionId } from "./history/identity.js";
import type { NativeTransaction } from "./history/native-history.js";
import type { NativeHistoryBundle } from "./history/native-store.js";
import { compareIds, END, START } from "./history/sequence.js";
import {
  checkGroupId, historyBudget, MAX_HISTORY_BYTES, validateManifest, type NativeGroupManifest,
} from "./history/transaction-group.js";
import { actorId, documentId, externalBaseId, replicaId, type TransactionGroupId, type TransactionId } from "./identity.js";
import { readSourcePosition, restoreSourcePosition, type SourcePositionPayload } from "./model/source-revision.js";
import { nativeContextState } from "./native-definition.js";

const HISTORY_MAGIC = Object.freeze([0x5a, 0x48, 0x42, 0x31]);
const POSITION_MAGIC = Object.freeze([0x5a, 0x48, 0x50, 0x31]);
const CODEC_VERSION = 1;
const HEADER_BYTES = 9;
const MAX_POSITION_PAYLOAD = 64 * 1024;

function bad(message: string): never {
  throw new EditorError("INVALID_REFERENCE", `INVALID_REFERENCE: ${message}`);
}
const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const own = Object.keys(record).sort();
  const wanted = [...keys].sort();
  if (own.length !== wanted.length || own.some((key, index) => key !== wanted[index])) {
    bad("unexpected payload fields");
  }
}

function frame(magic: readonly number[], payload: string): Uint8Array {
  const body = utf8(payload);
  const bytes = new Uint8Array(HEADER_BYTES + body.length);
  bytes.set(magic, 0);
  bytes[4] = CODEC_VERSION;
  new DataView(bytes.buffer).setUint32(5, body.length);
  bytes.set(body, HEADER_BYTES);
  return bytes;
}

function unframe(input: Uint8Array, magic: readonly number[], maxPayload: number): string {
  if (!(input instanceof Uint8Array)) bad("codec input must be a Uint8Array");
  if (input.length < HEADER_BYTES) {
    throw new EditorError("UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT: truncated envelope header");
  }
  for (let index = 0; index < 4; index++) {
    if (input[index] !== magic[index]) {
      throw new EditorError("UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT: unknown envelope magic");
    }
  }
  if (input[4] !== CODEC_VERSION) {
    throw new EditorError("UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT: unsupported codec version");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const declared = view.getUint32(5, false);
  if (declared > maxPayload) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: envelope payload exceeds its budget");
  if (input.length !== HEADER_BYTES + declared) {
    if (input.length < HEADER_BYTES + declared) bad("truncated envelope payload");
    bad("envelope has trailing bytes");
  }
  return decodeUtf8Strict(input.subarray(HEADER_BYTES));
}

function parseCanonical(text: string, maxBytes: number): unknown {
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { bad("payload is not valid JSON"); }
  const canonical = canonicalJson(value, maxBytes);
  if (canonical !== text) bad("payload is not canonical JSON");
  return value;
}

function checkEffect(value: unknown): void {
  if (!plainObject(value)) bad("malformed effect");
  if (value.kind === "delete") {
    exactKeys(value, ["kind", "targets"]);
    if (!Array.isArray(value.targets) || !value.targets.length) bad("malformed deletion");
    for (const target of value.targets) checkElementId(target as string);
    return;
  }
  if (value.kind === "insert") {
    exactKeys(value, ["kind", "id", "scalar", "parent", "side", "left", "right"]);
    checkElementId(value.id as string);
    const scalar = value.scalar;
    if (typeof scalar !== "string" || [...scalar].length !== 1) bad("insertion scalar");
    scalarUtf8Length(scalar as string);
    for (const reference of [value.parent, value.left, value.right]) {
      if (reference === START || reference === END) continue;
      checkElementId(reference as string);
    }
    if (value.side !== "L" && value.side !== "R") bad("insertion side");
    return;
  }
  bad("unknown effect kind");
}

function checkTransaction(value: unknown): void {
  if (!plainObject(value)) bad("malformed transaction");
  const required = ["actor", "depends", "effects", "group", "id", "origin", "replica", "root"] as const;
  for (const key of required) if (!Object.hasOwn(value, key)) bad("transaction misses a required field");
  exactKeys(value, [...required, ...(Object.hasOwn(value, "attribution") ? ["attribution"] : []),
    ...(Object.hasOwn(value, "control") ? ["control"] : [])]);
  checkTransactionId(value.id as TransactionId);
  checkGroupId(value.group as TransactionGroupId);
  checkRootId(value.root as string);
  actorId(value.actor as string);
  replicaId(value.replica as string);
  if (!plainObject(value.origin)) bad("transaction origin");
  exactKeys(value.origin, Object.hasOwn(value.origin, "label") ? ["kind", "label"] : ["kind"]);
  if (typeof value.origin.kind !== "string" || !(value.origin.kind as string).length) bad("transaction origin kind");
  if (Object.hasOwn(value.origin, "label") && typeof value.origin.label !== "string") bad("transaction origin label");
  if (!Array.isArray(value.depends)) bad("transaction dependencies");
  let previous: string | null = null;
  for (const dependency of value.depends) {
    checkTransactionId(dependency as TransactionId);
    if (dependency === value.id) bad("transaction depends on itself");
    if (previous !== null && compareIds(previous, dependency as string) >= 0) {
      bad("transaction dependencies are not a canonical frontier");
    }
    previous = dependency as string;
  }
  if (!Array.isArray(value.effects)) bad("transaction effects");
  for (const effect of value.effects) checkEffect(effect);
  if (Object.hasOwn(value, "control")) {
    const control = value.control;
    if (!plainObject(control)) bad("malformed control");
    exactKeys(control, ["target", "member", "generation", "active", "order"]);
    checkGroupId(control.target as TransactionGroupId);
    checkTransactionId(control.member as TransactionId);
    checkTransactionId(control.order as TransactionId);
    if (typeof control.generation !== "number" || !Number.isSafeInteger(control.generation) || control.generation < 0) {
      bad("control generation");
    }
    if (typeof control.active !== "boolean") bad("control activity");
  }
}

function checkManifest(value: unknown): NativeGroupManifest {
  if (!plainObject(value)) bad("malformed manifest");
  exactKeys(value, ["id", "members"]);
  checkGroupId(value.id as TransactionGroupId);
  if (!Array.isArray(value.members) || !value.members.length) bad("manifest members");
  for (const member of value.members) {
    if (!plainObject(member)) bad("malformed group member");
    exactKeys(member, ["document", "base", "root", "transaction", "before", "after"]);
    if (!Array.isArray(member.before) || !Array.isArray(member.after)) bad("group member frontiers");
  }
  return validateManifest(value as unknown as NativeGroupManifest);
}

function checkHistories(value: unknown): readonly { readonly transactions: readonly NativeTransaction[] }[] {
  if (!Array.isArray(value)) bad("bundle histories");
  const seen = new Set<string>();
  for (const history of value) {
    if (!plainObject(history)) bad("malformed history");
    exactKeys(history, ["document", "root", "transactions"]);
    const document = documentId(history.document as string);
    if (seen.has(document)) bad("duplicate history document");
    seen.add(document);
    checkRootId(history.root as string);
    if (!Array.isArray(history.transactions)) bad("history transactions");
    for (const transaction of history.transactions) checkTransaction(transaction);
  }
  return value as readonly { readonly transactions: readonly NativeTransaction[] }[];
}

function checkTargets(value: unknown): void {
  if (!Array.isArray(value)) bad("bundle target");
  const seen = new Set<string>();
  for (const target of value) {
    if (!plainObject(target)) bad("malformed target");
    exactKeys(target, ["document", "root", "frontier"]);
    const document = documentId(target.document as string);
    if (seen.has(document)) bad("duplicate target document");
    seen.add(document);
    checkRootId(target.root as string);
    if (!Array.isArray(target.frontier)) bad("target frontier");
    let previous: string | null = null;
    for (const id of target.frontier) {
      checkTransactionId(id as TransactionId);
      if (previous !== null && compareIds(previous, id as string) >= 0) bad("target frontier is not canonical");
      previous = id as string;
    }
  }
}

/** Structural + budget validation shared by encode and decode; semantics stay with the kernel. */
function validateBundle(value: unknown): NativeHistoryBundle {
  if (!plainObject(value)) bad("bundle payload");
  exactKeys(value, ["histories", "manifests", "target"]);
  if (!Array.isArray(value.manifests)) bad("bundle manifests");
  const manifests = value.manifests.map((manifest) => checkManifest(manifest));
  const histories = checkHistories(value.histories);
  checkTargets(value.target);
  const transactions = histories.flatMap((history) => [...history.transactions]);
  historyBudget({ manifests, histories: value.histories, target: value.target }, transactions);
  return canonicalCopy({ manifests, histories: value.histories, target: value.target }) as NativeHistoryBundle;
}

function validatePositionPayload(value: unknown): SourcePositionPayload {
  const position = restoreSourcePosition(value);
  return canonicalCopy(readSourcePosition(position));
}

/**
 * Versioned byte codec for native history bundles. The envelope carries a magic,
 * codec version, exact payload length and canonical UTF-8 JSON; every identity
 * and structure is validated before the bundle becomes an opaque value.
 */
export function encodeHistoryBundle(bundle: HistoryBundle): Uint8Array {
  const payload = nativeContextState.api.bundles<NativeHistoryBundle>().read(bundle);
  return frame(HISTORY_MAGIC, canonicalJson(validateBundle(payload), MAX_HISTORY_BYTES));
}

export function decodeHistoryBundle(bytes: Uint8Array): HistoryBundle {
  const text = unframe(bytes, HISTORY_MAGIC, MAX_HISTORY_BYTES);
  const payload = validateBundle(parseCanonical(text, MAX_HISTORY_BYTES));
  return nativeContextState.api.bundles<NativeHistoryBundle>().create(payload);
}

/** Versioned byte codec for portable position tokens; decoding never writes to a store. */
export function encodePositionToken(token: PositionToken): Uint8Array {
  const payload = nativeContextState.api.positionTokens<SourcePositionPayload>().read(token);
  return frame(POSITION_MAGIC, canonicalJson(validatePositionPayload(payload), MAX_POSITION_PAYLOAD));
}

export function decodePositionToken(bytes: Uint8Array): PositionToken {
  const text = unframe(bytes, POSITION_MAGIC, MAX_POSITION_PAYLOAD);
  const payload = validatePositionPayload(parseCanonical(text, MAX_POSITION_PAYLOAD));
  return nativeContextState.api.positionTokens<SourcePositionPayload>().create(payload);
}
