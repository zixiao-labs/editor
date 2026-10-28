import { expect, test } from "@lightning-js/lightning";
import type { RevisionSet, TextSnapshot } from "../../src/contracts/core.js";
import { actorId, documentId, externalBaseId, replicaId, type TransactionId } from "../../src/identity.js";
import { NativeStore } from "../../src/history/native-store.js";
import { SpecReplica, type SpecTransaction } from "./support/replica.js";

const rawSeed = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SEED ?? "424242";
if (!/^\d+$/.test(rawSeed) || !Number.isSafeInteger(Number(rawSeed)) || Number(rawSeed) > 0xffffffff) {
  throw new Error("SEED must be a uint32 decimal integer");
}
const seed = Number(rawSeed);

test(`native heads preserve exact causal sets across offline edits, captured merges and checkout; seed=${seed}`, () => {
  for (let run = 0; run < 12; run++) {
    let randomState = (seed + run * 97) >>> 0;
    const next = (limit: number) => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState % limit;
    };
    let stream = 1;
    const store = new NativeStore({ random: { fill(bytes) { bytes.fill(stream++); } } });
    const document = documentId("heads:document");
    const initial = store.createDocument({
      id: document, base: { id: externalBaseId("heads:base"), text: "A😀\r\n" },
    });
    const writers = [1, 2, 3].map((id) => store.openWriter({ actor: actorId(`actor:${id}`), replica: replicaId(`replica:${id}`) }));
    const heads = writers.map((writer) => store.fork({ at: store.revisions([initial]), writer }));
    const states = heads.map(() => new Set<TransactionId>());
    const model = new SpecReplica("A😀\r\n");
    const saved: { at: RevisionSet; state: Set<TransactionId>; text: string; snapshot: TextSnapshot }[] = [];
    const actions: unknown[] = [];
    const transactions: SpecTransaction[] = [];
    const verify = (index: number) => {
      const head = heads[index]!;
      const revision = head.checkpoint().revisions.get(document);
      const actual = store.history.transactions({ document, includedIn: revision, limit: 10_000 }).items;
      expect(actual.map((tx) => tx.id).sort()).toEqual([...states[index]!].sort());
      const snapshot = head.snapshot(document);
      try {
        expect(snapshot.text()).toBe(model.text([...states[index]!]));
        const spans = store.history.provenance({ document, revision, range: snapshot.rangeUtf16(0, snapshot.lengthUtf16) });
        const creators = spans.flatMap((span) =>
          [...snapshot.text().slice(span.range.start, span.range.end)].map(() => span.transaction ?? "root"));
        expect(creators).toEqual(model.snapshot([...states[index]!]).creators);
      } finally { snapshot.dispose(); }
    };
    try {
      for (let step = 0; step < 32; step++) {
        const index = next(3);
        const head = heads[index]!;
        const before = head.checkpoint();
        const snapshot = head.snapshot(document);
        saved.push({ at: before.revisions, state: new Set(states[index]), text: snapshot.text(), snapshot });
        const kind = next(4);
        if (kind < 2 || saved.length < 2) {
          const text = snapshot.text();
          const boundaries = [0];
          for (const scalar of text) boundaries.push(boundaries[boundaries.length - 1]! + scalar.length);
          const low = next(boundaries.length);
          const high = low + next(boundaries.length - low);
          const start = boundaries[low]!;
          const end = boundaries[high]!;
          const inserted = ["x", "😀", "\u0301", "\r\n", ""][next(5)]!;
          actions.push({ index, start, end, inserted });
          const result = head.commit({
            expect: before, edits: [{ document, range: snapshot.rangeUtf16(start, end), text: inserted }],
            origin: { kind: "seeded-head" }, attribution: { run, step },
          });
          if (text.slice(0, start) + inserted + text.slice(end) === text) {
            expect(result.status).toBe("no-change");
            expect(result.after).toBe(before);
          } else {
            const id = result.transactions[0]!;
            const tx = model.edit(id, start, end, inserted, [...states[index]!]);
            model.receive([tx]);
            transactions.push(tx);
            states[index]!.add(id);
          }
        } else {
          const targetIndex = next(saved.length);
          const target = saved[targetIndex]!;
          actions.push({ index, kind: kind === 2 ? "merge" : "checkout", saved: targetIndex });
          if (kind === 2) {
            head.merge({ expect: before, source: target.at });
            states[index] = new Set([...states[index]!, ...target.state]);
          } else {
            head.checkout({ expect: before, at: target.at });
            states[index] = new Set(target.state);
            expect(() => head.merge({ expect: before, source: target.at })).toThrow("STALE_CHECKPOINT");
          }
        }
        for (let peer = 0; peer < heads.length; peer++) verify(peer);
      }
      for (const old of saved) {
        expect(old.snapshot.text()).toBe(old.text);
        expect(old.text).toBe(model.text([...old.state]));
      }
    } catch (cause) {
      // Preserve the entire state-machine replay. A transaction-only causal
      // reducer cannot safely shrink commands that index earlier checkout cuts.
      throw new Error(JSON.stringify({
        seed, run, actions, transactions, expectedStates: states.map((state) => [...state]),
      }, null, 2), { cause });
    } finally {
      for (const old of saved) old.snapshot.dispose();
      for (const head of heads) head.dispose();
      for (const writer of writers) writer.dispose();
      store.dispose();
    }
  }
});
