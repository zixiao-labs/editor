import { expect, test } from "@lightning-js/lightning";
import { actorId, documentId, externalBaseId, replicaId } from "../../src/identity.js";
import { framedDigest, sha256, utf8 } from "../../src/history/canonical.js";
import { createRoot, NativeWriter } from "../../src/history/identity.js";

test("synchronous SHA-256 matches standard short, multi-block and million-byte vectors", () => {
  expect(sha256(utf8(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(sha256(utf8("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))
    .toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  expect(sha256(utf8("a".repeat(1_000_000))))
    .toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
});

test("root identity frames exact UTF-8 fields and matches independently computed Node crypto digest", () => {
  const input = { document: documentId("test:doc"), base: externalBaseId("test:base"), text: "A😀\r\n" };
  const root = createRoot(input);
  expect(root.id).toBe("root:09a151d4e273ad5d27749e8c3bc90472027b6f4e7d59ef2651276ea0e8992f36");
  expect(createRoot({ ...input }).id).toBe(root.id);
  for (const changed of [
    { document: documentId("other") }, { base: externalBaseId("other") },
    { text: "A😀\n" }, { text: "A😀\r" },
  ]) expect(createRoot({ ...input, ...changed }).id).not.toBe(root.id);
  expect(createRoot({ ...input, text: "é" }).id).not.toBe(createRoot({ ...input, text: "e\u0301" }).id);
  expect(framedDigest("d", ["ab", "c"])).not.toBe(framedDigest("d", ["a", "bc"]));
  expect(framedDigest("d", ["a"])).not.toBe(framedDigest("e", ["a"]));
  expect(() => createRoot({ ...input, text: "\ud800" })).toThrow("INVALID_UNICODE");
  expect(Object.isFrozen(root)).toBe(true);
});

test("writer uses a copied 128-bit stream and monotonically allocated uint64 IDs", () => {
  let borrowed: Uint8Array | undefined;
  const writer = new NativeWriter({
    actor: actorId("actor"), replica: replicaId("replica"),
    random: { fill(bytes) { bytes.fill(0x12); borrowed = bytes; } },
  });
  borrowed!.fill(0xff);
  expect(writer.allocate()).toBe("t:12121212121212121212121212121212:0000000000000001");
  expect(writer.allocate()).toBe("t:12121212121212121212121212121212:0000000000000002");
  writer.dispose();
  writer.dispose();
  expect(() => writer.allocate()).toThrow("DISPOSED");
  expect(() => new NativeWriter({
    actor: actorId("a"), replica: replicaId("r"), random: { fill() { throw new Error("offline"); } },
  })).toThrow("RANDOM_UNAVAILABLE");
});

test("tentative writer allocations consume counters only on commit and reject stale or forged plans", () => {
  const writer = new NativeWriter({
    actor: actorId("actor"), replica: replicaId("replica"), random: { fill(bytes) { bytes.fill(7); } },
  });
  const abandoned = writer.plan(2);
  const chosen = writer.plan(3);
  expect(chosen.ids[0]).toBe(abandoned.ids[0]);
  expect(Object.isFrozen(chosen.ids)).toBe(true);
  expect(() => writer.commit({ ids: chosen.ids })).toThrow("INVALID_REFERENCE");
  writer.commit(chosen);
  expect(() => writer.commit(chosen)).toThrow("INVALID_REFERENCE");
  expect(() => writer.commit(abandoned)).toThrow("INVALID_REFERENCE");
  expect(writer.allocate().slice(-16)).toBe("0000000000000004");
  expect(() => writer.plan(0)).toThrow("INVALID_RANGE");
  const pending = writer.plan(1);
  writer.dispose();
  expect(() => writer.commit(pending)).toThrow("DISPOSED");
});
