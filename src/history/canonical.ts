import { scalarUtf8Length } from "../coordinates/text-index.js";
import { EditorError } from "../errors.js";

/** Exact UTF-8, without platform globals, replacement characters or normalization. */
export function utf8(text: string): Uint8Array {
  if (typeof text !== "string") throw new EditorError("INVALID_UNICODE", "INVALID_UNICODE: expected text");
  let length = 0;
  for (const scalar of text) length += scalarUtf8Length(scalar);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    if (code < 0x80) bytes[offset++] = code;
    else if (code < 0x800) {
      bytes[offset++] = 0xc0 | (code >>> 6);
      bytes[offset++] = 0x80 | (code & 63);
    } else if (code < 0x10000) {
      bytes[offset++] = 0xe0 | (code >>> 12);
      bytes[offset++] = 0x80 | ((code >>> 6) & 63);
      bytes[offset++] = 0x80 | (code & 63);
    } else {
      bytes[offset++] = 0xf0 | (code >>> 18);
      bytes[offset++] = 0x80 | ((code >>> 12) & 63);
      bytes[offset++] = 0x80 | ((code >>> 6) & 63);
      bytes[offset++] = 0x80 | (code & 63);
    }
  }
  return bytes;
}

// SHA-256 constants and compression from FIPS 180-4 sections 4.2.2, 5 and 6.2.
// Synchronous because document/revision registration is synchronous; no Node or
// DOM crypto imports, lazy providers, network, or async mutation of identities.
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const rotate = (word: number, bits: number): number => (word >>> bits) | (word << (32 - bits));

export function sha256(input: Uint8Array): string {
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  const data = new DataView(padded.buffer);
  data.setBigUint64(padded.length - 8, BigInt(input.length) * 8n);
  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = data.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15]!;
      const b = words[i - 2]!;
      words[i] = words[i - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
        words[i - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = Array.from(state) as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
        ((e & f) ^ (~e & g)) + K[i]! + words[i]!) >>> 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
        ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((word, i) => { state[i] = state[i]! + word; });
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** Every field, including the domain, is preceded by its uint64 BE byte length. */
export function framedDigest(domain: string, fields: readonly string[]): string {
  const encoded = [domain, ...fields].map(utf8);
  const bytes = new Uint8Array(encoded.reduce((length, field) => length + 8 + field.length, 0));
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of encoded) {
    view.setBigUint64(offset, BigInt(field.length));
    bytes.set(field, offset + 8);
    offset += 8 + field.length;
  }
  return sha256(bytes);
}

/**
 * Internal canonical JSON: UTF-16 code-unit key order, JSON finite numbers (-0
 * becomes 0), exact scalar strings. Not a public codec or a claim of RFC 8785.
 * Reject non-JSON values, accessors, sparse arrays, cycles and excessive depth.
 */
export function canonicalJson(value: unknown, maxBytes: number = 8 * 1024 * 1024): string {
  const active = new Set<object>();
  const invalid = (): never => { throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: expected plain JSON"); };
  const encode = (item: unknown, depth: number): string => {
    if (depth > 64) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: JSON nesting exceeds 64");
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") return Number.isFinite(item) ? JSON.stringify(item) : invalid();
    if (typeof item === "string") { utf8(item); return JSON.stringify(item); }
    if (typeof item !== "object" || active.has(item)) return invalid();
    const array = Array.isArray(item);
    if (!array && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return invalid();
    active.add(item);
    const field = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) return invalid();
      return descriptor.value;
    };
    const parts: string[] = [];
    if (array) {
      for (let i = 0; i < item.length; i++) parts.push(encode(field(String(i)), depth + 1));
    } else {
      for (const key of Object.keys(item).sort()) {
        utf8(key);
        parts.push(`${JSON.stringify(key)}:${encode(field(key), depth + 1)}`);
      }
    }
    active.delete(item);
    const result = array ? `[${parts.join(",")}]` : `{${parts.join(",")}}`;
    if (result.length > maxBytes) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: canonical JSON budget");
    return result;
  };
  const result = encode(value, 0);
  if (utf8(result).length > maxBytes) throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: canonical JSON budget");
  return result;
}

/** Validate, detach aliases and freeze the complete JSON value, not only its shell. */
export function canonicalCopy<T>(value: T, maxBytes?: number): T {
  const copy = JSON.parse(canonicalJson(value, maxBytes)) as T;
  const pending: unknown[] = [copy];
  while (pending.length) {
    const item = pending.pop();
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) pending.push(child);
      Object.freeze(item);
    }
  }
  return copy;
}
