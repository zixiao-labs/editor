import { expect, test } from "@lightning-js/lightning";
import {
  decodeHistoryBundle, decodePositionToken, encodeHistoryBundle, encodePositionToken,
} from "../../src/index.js";
import type { HistoryBundle, PositionToken } from "../../src/contracts/core.js";
import { actorId, documentId, externalBaseId, replicaId, type DocumentId } from "../../src/identity.js";
import { NativeStore, type NativeHistoryBundle } from "../../src/history/native-store.js";
import { canonicalJson } from "../../src/history/canonical.js";
import { createRoot } from "../../src/history/identity.js";
import { nativeContextState } from "../../src/native-backend.js";

const document = documentId("codec:document");
const base = externalBaseId("codec:base");
const MAGIC = { bundle: [0x5a, 0x48, 0x42, 0x31], position: [0x5a, 0x48, 0x50, 0x31] };

function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >>> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >>> 12), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >>> 18), 0x80 | ((code >>> 12) & 63), 0x80 | ((code >>> 6) & 63), 0x80 | (code & 63));
  }
  return Uint8Array.from(out);
}
function envelope(magic: readonly number[], version: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(9 + payload.length);
  bytes.set(magic, 0);
  bytes[4] = version;
  new DataView(bytes.buffer).setUint32(5, payload.length);
  bytes.set(payload, 9);
  return bytes;
}
function raw(text: string): Uint8Array { return envelope(MAGIC.bundle, 1, utf8Bytes(text)); }
function rawToken(text: string): Uint8Array { return envelope(MAGIC.position, 1, utf8Bytes(text)); }
function wrapBundle(payload: object): HistoryBundle {
  return nativeContextState.api.bundles<NativeHistoryBundle>().create(payload as NativeHistoryBundle);
}
function readBundle(bundle: HistoryBundle): NativeHistoryBundle {
  return nativeContextState.api.bundles<NativeHistoryBundle>().read(bundle);
}
function wrapToken<Payload>(payload: Payload): PositionToken {
  return nativeContextState.api.positionTokens<Payload>().create(payload);
}
function readToken<Payload>(token: PositionToken): Payload {
  return nativeContextState.api.positionTokens<Payload>().read(token);
}
function store(seed = 1) {
  let nonce = seed;
  return new NativeStore({ random: { fill(bytes) { bytes.fill(nonce++); } } });
}
function sampleBundle(): NativeHistoryBundle {
  const s = store(1);
  const initial = s.createDocument({ id: document, base: { id: base, text: "AB" } });
  const writer = s.openWriter({ actor: actorId("codec"), replica: replicaId("codec") });
  const head = s.fork({ at: s.revisions([initial]), writer });
  const snapshot = head.snapshot(document);
  head.commit({
    expect: head.checkpoint(), origin: { kind: "codec" },
    edits: [{ document, range: snapshot.rangeUtf16(1, 1), text: "😀" }],
  });
  snapshot.dispose();
  const bundle = s.exportTyped({ target: head.checkpoint().revisions });
  head.dispose(); writer.dispose(); s.dispose();
  return bundle;
}
function positionPayload() {
  const root = createRoot({ document, base, text: "AB" });
  return {
    v: 1, document: document as DocumentId, root: root.id, affinity: "after",
    guard: { kind: "element", id: `${root.id}/00000001` },
  };
}
function codeOf(action: () => unknown): string | undefined {
  try { action(); return undefined; } catch (cause) { return (cause as { code?: string }).code; }
}

test("history bundles round-trip through the versioned byte envelope with deterministic canonical bytes", () => {
  const payload = sampleBundle();
  const bundle = wrapBundle(payload);
  const bytes = encodeHistoryBundle(bundle);
  expect(bytes instanceof Uint8Array).toBe(true);
  expect([...bytes.slice(0, 4)]).toEqual(MAGIC.bundle);
  expect(bytes[4]).toBe(1);
  expect(new DataView(bytes.buffer).getUint32(5)).toBe(bytes.length - 9);
  expect([...encodeHistoryBundle(bundle)]).toEqual([...bytes]);
  const decoded = decodeHistoryBundle(bytes);
  expect(readBundle(decoded)).toEqual(payload);
  expect(Object.isFrozen(readBundle(decoded))).toBe(true);
  // A decoded bundle is accepted by the real kernel without a second encoder.
  const s = store(2);
  s.createDocument({ id: document, base: { id: base, text: "AB" } });
  const accepted = s.acceptBundle(readBundle(decoded));
  expect(accepted.status).toBe("accepted");
  const entry = [...accepted.availableRevisions.entries()][0]!;
  const snapshot = s.snapshot(entry);
  expect(snapshot.text()).toBe("A😀B");
  snapshot.dispose();
  s.dispose();
  expect(codeOf(() => encodeHistoryBundle({} as HistoryBundle))).toBe("UNSUPPORTED_FORMAT");
  const foreign = decodePositionToken(rawToken(canonicalJson(positionPayload())));
  expect(codeOf(() => encodeHistoryBundle(foreign as unknown as HistoryBundle))).toBe("UNSUPPORTED_FORMAT");
});

test("bundle decoding rejects malformed envelopes by class without partial results", () => {
  const valid = [...encodeHistoryBundle(wrapBundle({ histories: [], manifests: [], target: [] }))];
  const overBudget = envelope(MAGIC.bundle, 1, new Uint8Array());
  new DataView(overBudget.buffer).setUint32(5, 8 * 1024 * 1024 + 1);
  const nested = '{"histories":' + "[".repeat(66) + "0" + "]".repeat(66) + ',"manifests":[],"target":[]}';
  const cases: readonly (readonly [string, unknown, string])[] = [
    ["not bytes", "bytes", "INVALID_REFERENCE"],
    ["short header", new Uint8Array([0x5a, 0x48]), "UNSUPPORTED_FORMAT"],
    ["bad magic", envelope([0, 0, 0, 0], 1, new Uint8Array()), "UNSUPPORTED_FORMAT"],
    ["bad version", envelope(MAGIC.bundle, 2, new Uint8Array()), "UNSUPPORTED_FORMAT"],
    ["declared over budget", overBudget, "LIMIT_EXCEEDED"],
    ["trailing byte", Uint8Array.from([...valid, 0]), "INVALID_REFERENCE"],
    ["truncated payload", Uint8Array.from(valid.slice(0, valid.length - 1)), "INVALID_REFERENCE"],
    ["invalid utf8", envelope(MAGIC.bundle, 1, Uint8Array.from([0x7b, 0xff, 0x7d])), "INVALID_REFERENCE"],
    ["overlong utf8", envelope(MAGIC.bundle, 1, Uint8Array.from([0xc0, 0x80])), "INVALID_REFERENCE"],
    ["lone continuation", envelope(MAGIC.bundle, 1, Uint8Array.from([0x80])), "INVALID_REFERENCE"],
    ["truncated multibyte", envelope(MAGIC.bundle, 1, Uint8Array.from([0xe2, 0x82])), "INVALID_REFERENCE"],
    ["surrogate utf8", envelope(MAGIC.bundle, 1, Uint8Array.from([0xed, 0xa0, 0x80])), "INVALID_REFERENCE"],
    ["empty payload", raw(""), "INVALID_REFERENCE"],
    ["bad json", raw("{"), "INVALID_REFERENCE"],
    ["non-canonical order", raw('{"manifests":[],"histories":[],"target":[]}'), "INVALID_REFERENCE"],
    ["non-canonical whitespace", raw('{"histories": [], "manifests": [], "target": []}'), "INVALID_REFERENCE"],
    ["wrong shape", raw("{}"), "INVALID_REFERENCE"],
    ["array shape", raw("[]"), "INVALID_REFERENCE"],
    ["unknown field", raw(canonicalJson({ histories: [], manifests: [], target: [], extra: true })), "INVALID_REFERENCE"],
    ["deep nesting", raw(nested), "LIMIT_EXCEEDED"],
    ["bad target id", raw(canonicalJson({
      histories: [], manifests: [],
      target: [{ document, root: "root:" + "0".repeat(64), frontier: ["not-a-transaction"] }],
    })), "INVALID_REFERENCE"],
    ["bad target root", raw(canonicalJson({
      histories: [], manifests: [],
      target: [{ document, root: "root:nope", frontier: [] }],
    })), "INVALID_REFERENCE"],
    ["bad document", raw(canonicalJson({
      histories: [{ document: "codec\u0001document", root: "root:" + "0".repeat(64), transactions: [] }],
      manifests: [], target: [],
    })), "INVALID_REFERENCE"],
    ["duplicate history document", raw(canonicalJson({
      histories: [
        { document, root: "root:" + "0".repeat(64), transactions: [] },
        { document, root: "root:" + "0".repeat(64), transactions: [] },
      ],
      manifests: [], target: [],
    })), "INVALID_REFERENCE"],
  ];
  for (const [label, input, code] of cases) {
    const actual = codeOf(() => decodeHistoryBundle(input as Uint8Array));
    expect(`${label}: ${actual}`).toBe(`${label}: ${code}`);
  }
});

test("tampered manifests are identity conflicts while malformed semantics stay invalid references", () => {
  const payload = sampleBundle();
  const manifest = payload.manifests[0]!;
  const tampered = { ...payload, manifests: [{ ...manifest, id: "group:" + "f".repeat(64) }] };
  expect(codeOf(() => decodeHistoryBundle(raw(canonicalJson(tampered))))).toBe("IDENTITY_CONFLICT");
  const badEffects = {
    ...payload,
    histories: payload.histories.map((history) => ({
      ...history,
      transactions: history.transactions.map((tx) => ({ ...tx, effects: [{ kind: "delete", targets: [true] }] })),
    })),
  };
  expect(codeOf(() => decodeHistoryBundle(raw(canonicalJson(badEffects))))).toBe("INVALID_REFERENCE");
  const badDepends = {
    ...payload,
    histories: payload.histories.map((history) => ({
      ...history,
      transactions: history.transactions.map((tx) => ({ ...tx, depends: [tx.id] })),
    })),
  };
  expect(codeOf(() => decodeHistoryBundle(raw(canonicalJson(badDepends))))).toBe("INVALID_REFERENCE");
});

test("position tokens round-trip strictly and reject foreign or malformed payloads", () => {
  const payload = positionPayload();
  const token = wrapToken(payload);
  const bytes = encodePositionToken(token);
  expect([...bytes.slice(0, 4)]).toEqual(MAGIC.position);
  expect([...encodePositionToken(token)]).toEqual([...bytes]);
  expect(readToken<typeof payload>(decodePositionToken(bytes))).toEqual(payload);
  expect(Object.isFrozen(readToken<typeof payload>(decodePositionToken(bytes)))).toBe(true);
  expect(codeOf(() => decodePositionToken(encodeHistoryBundle(wrapBundle({ histories: [], manifests: [], target: [] })))))
    .toBe("UNSUPPORTED_FORMAT");
  expect(codeOf(() => encodePositionToken({} as PositionToken))).toBe("UNSUPPORTED_FORMAT");
  const { v: _v, ...withoutV } = payload;
  const variants: readonly (readonly [string, string, string])[] = [
    ["missing v", canonicalJson(withoutV), "INVALID_REFERENCE"],
    ["non-numeric v", canonicalJson({ ...payload, v: "1" }), "INVALID_REFERENCE"],
    ["future version", canonicalJson({ ...payload, v: 2 }), "UNSUPPORTED_FORMAT"],
    ["extra field", canonicalJson({ ...payload, extra: 1 }), "INVALID_REFERENCE"],
    ["bad affinity", canonicalJson({ ...payload, affinity: "middle" }), "INVALID_REFERENCE"],
    ["bad guard kind", canonicalJson({ ...payload, guard: { kind: "middle" } }), "INVALID_REFERENCE"],
    ["bad guard element", canonicalJson({ ...payload, guard: { kind: "element", id: "element:1" } }), "INVALID_REFERENCE"],
    ["start guard with id", canonicalJson({ ...payload, guard: { kind: "start", id: payload.guard.id } }), "INVALID_REFERENCE"],
    ["bad root", canonicalJson({ ...payload, root: "root:zz" }), "INVALID_REFERENCE"],
    ["bad document", canonicalJson({ ...payload, document: "codec\u0000document" }), "INVALID_REFERENCE"],
    ["not object", canonicalJson([1, 2]), "INVALID_REFERENCE"],
    ["empty payload", "", "INVALID_REFERENCE"],
  ];
  for (const [label, text, code] of variants) {
    const actual = codeOf(() => decodePositionToken(rawToken(text)));
    expect(`${label}: ${actual}`).toBe(`${label}: ${code}`);
  }
  const sentinel = { ...payload, guard: { kind: "start" } as const };
  expect(readToken<typeof sentinel>(decodePositionToken(encodePositionToken(wrapToken(sentinel))))).toEqual(sentinel);
  const oversized = envelope(MAGIC.position, 1, new Uint8Array());
  new DataView(oversized.buffer).setUint32(5, 64 * 1024 + 1);
  expect(codeOf(() => decodePositionToken(oversized))).toBe("LIMIT_EXCEEDED");
});
