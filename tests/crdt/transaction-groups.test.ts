import { expect, test } from "@lightning-js/lightning";
import type { RevisionSet, TextSnapshot } from "../../src/contracts/core.js";
import { NativeStore, type NativeHistoryBundle } from "../../src/history/native-store.js";
import {
  actorId, documentId, externalBaseId, replicaId, type DocumentId, type TransactionGroupId, type TransactionId,
} from "../../src/identity.js";
import { SpecReplica } from "./support/replica.js";

const documents = [documentId("groups:a"), documentId("groups:b"), documentId("groups:c")] as const;
const bases = ["AB", "😀", "\r\n"];
const base = externalBaseId("groups:base");
type State = Map<DocumentId, Set<TransactionId>>;
interface Command { readonly document: DocumentId; readonly start: number; readonly end: number; readonly text: string }
interface RecordedTransaction { readonly id: TransactionId; readonly document: DocumentId; readonly depends: readonly TransactionId[] }
interface Group { readonly id: TransactionGroupId; readonly members: readonly RecordedTransaction[] }
const clone = (state: State): State => new Map([...state].map(([doc, ids]) => [doc, new Set(ids)]));

/** Flat all-or-none membership oracle; no production manifest/closure/hash helpers. */
function groupClosed(state: State, groups: readonly Group[]): boolean {
  return groups.every((group) => {
    const count = group.members.filter((member) => state.get(member.document)!.has(member.id)).length;
    return count === 0 || count === group.members.length;
  });
}
function world() {
  let stream = 1;
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(stream++); } } });
  const initial = documents.map((document, i) => store.createDocument({ id: document, base: { id: base, text: bases[i]! } }));
  const writers = documents.map((_, i) => store.openWriter({ actor: actorId(`actor:${i}`), replica: replicaId(`replica:${i}`) }));
  const heads = writers.map((writer) => store.fork({ at: store.revisions(initial), writer }));
  const models = new Map(documents.map((document, i) => [document, new SpecReplica(bases[i]!) ]));
  const states = heads.map((): State => new Map(documents.map((document) => [document, new Set<TransactionId>()])));
  const records: RecordedTransaction[] = [];
  const groups: Group[] = [];
  const actions: unknown[] = [];
  const commit = (index: number, commands: readonly Command[]) => {
    const head = heads[index]!;
    const before = states[index]!;
    const changed = commands.filter((command) => {
      const text = models.get(command.document)!.text([...before.get(command.document)!]);
      return text.slice(0, command.start) + command.text + text.slice(command.end) !== text;
    }).sort((a, b) => a.document < b.document ? -1 : 1);
    actions.push({ index, commands });
    const receipt = head.commit({
      expect: head.checkpoint(), origin: { kind: "group-differential" },
      edits: commands.map((command) => {
        const snapshot = head.snapshot(command.document);
        try { return { document: command.document, range: snapshot.rangeUtf16(command.start, command.end), text: command.text }; }
        finally { snapshot.dispose(); }
      }),
    });
    expect(receipt.documents).toEqual(changed.map((command) => command.document));
    if (!changed.length) { expect(receipt.status).toBe("no-change"); return; }
    expect(receipt.groups.length).toBe(1);
    const members = changed.map((command, i) => {
      const id = receipt.transactions[i]!;
      const depends = [...before.get(command.document)!];
      const model = models.get(command.document)!;
      const tx = model.edit(id, command.start, command.end, command.text, depends);
      model.receive([tx]);
      before.get(command.document)!.add(id);
      const record = { id, document: command.document, depends };
      records.push(record);
      return record;
    });
    groups.push({ id: receipt.groups[0]!, members });
  };
  const verify = (owner: NativeStore, at: RevisionSet, expected: State) => {
    expect(groupClosed(expected, groups)).toBe(true);
    for (const document of documents) {
      const revision = at.get(document);
      expect(owner.history.transactions({ document, includedIn: revision, limit: 10_000 }).items.map((tx) => tx.id).sort())
        .toEqual([...expected.get(document)!].sort());
      const snapshot = owner.snapshot({ document, revision });
      try {
        expect(snapshot.text()).toBe(models.get(document)!.text([...expected.get(document)!]));
        const spans = owner.history.provenance({ document, revision, range: snapshot.rangeUtf16(0, snapshot.lengthUtf16) });
        const creators = spans.flatMap((span) =>
          [...snapshot.text().slice(span.range.start, span.range.end)].map(() => span.transaction ?? "root"));
        expect(creators).toEqual(models.get(document)!.snapshot([...expected.get(document)!]).creators);
      } finally { snapshot.dispose(); }
    }
  };
  const receiver = () => {
    const owner = new NativeStore();
    documents.forEach((document, i) => owner.createDocument({ id: document, base: { id: base, text: bases[i]! } }));
    return owner;
  };
  const dispose = () => {
    for (const head of heads) head.dispose();
    for (const writer of writers) writer.dispose();
    store.dispose();
  };
  return { store, heads, states, models, records, groups, actions, commit, verify, receiver, dispose };
}

test("every multi-source causal cut agrees with a flat group-membership oracle and independent text models", () => {
  const w = world();
  try {
    const [a, b, c] = documents;
    w.commit(0, [{ document: a, start: 0, end: 0, text: "a" }, { document: b, start: 0, end: 0, text: "b" }]);
    w.commit(1, [{ document: b, start: 0, end: 0, text: "x" }, { document: c, start: 0, end: 0, text: "y" }]);
    w.heads[0]!.merge({ expect: w.heads[0]!.checkpoint(), source: w.heads[1]!.checkpoint().revisions });
    for (const document of documents) for (const id of w.states[1]!.get(document)!) w.states[0]!.get(document)!.add(id);
    w.commit(0, [{ document: a, start: 0, end: 1, text: "c" }, { document: c, start: 0, end: 1, text: "z" }]);
    w.commit(2, [{ document: a, start: 0, end: 0, text: "q" }, { document: b, start: 0, end: 0, text: "r" }]);
    w.heads[0]!.merge({ expect: w.heads[0]!.checkpoint(), source: w.heads[2]!.checkpoint().revisions });
    const full = w.store.exportTyped({ target: w.heads[0]!.checkpoint().revisions });
    let accepted = 0, rejected = 0;
    for (let mask = 0; mask < 2 ** w.records.length; mask++) {
      const selected = w.records.filter((_, i) => mask & (1 << i));
      if (selected.some((record) => record.depends.some((id) => !selected.some((other) => other.id === id)))) continue;
      const state: State = new Map(documents.map((document) => [document,
        new Set(selected.filter((record) => record.document === document).map((record) => record.id))]));
      const expected = groupClosed(state, w.groups);
      const selectedIds = new Set(selected.map((record) => record.id));
      const relevant = new Set(w.groups.filter((group) => group.members.some((member) => selectedIds.has(member.id))).map((group) => group.id));
      const bundle: NativeHistoryBundle = {
        histories: full.histories.map((history) => ({ ...history, transactions: history.transactions.filter((tx) => selectedIds.has(tx.id)) })),
        manifests: full.manifests.filter((manifest) => relevant.has(manifest.id)),
        target: full.target.map((target) => ({ ...target, frontier: [...state.get(target.document)!] })),
      };
      const receiver = w.receiver();
      try {
        if (expected) {
          const result = receiver.acceptBundle(bundle);
          w.verify(receiver, result.availableRevisions, state);
          expect(receiver.acceptBundle(bundle).status).toBe("duplicate");
          accepted++;
        } else {
          expect(() => receiver.acceptBundle(bundle)).toThrow("INCOMPLETE_TRANSACTION_GROUP");
          for (const record of selected) expect(() => receiver.history.transaction(record.id)).toThrow("INVALID_REFERENCE");
          rejected++;
        }
      } catch (cause) {
        throw new Error(JSON.stringify({ mask, expected, selected, groups: w.groups, actions: w.actions }, null, 2), { cause });
      } finally { receiver.dispose(); }
    }
    expect(accepted).toBe(10);
    expect(rejected).toBe(134);
    // Negative control: retaining each source's causal closure is not enough.
    const broken: State = new Map(documents.map((document) => [document,
      new Set(w.records.filter((record) => record.document === document).map((record) => record.id))]));
    broken.get(w.groups[3]!.members[0]!.document)!.delete(w.groups[3]!.members[0]!.id);
    const remaining = w.records.filter((record) => broken.get(record.document)!.has(record.id));
    expect(remaining.every((record) => record.depends.every((id) => remaining.some((other) => other.id === id)))).toBe(true);
    expect(groupClosed(broken, w.groups)).toBe(false);
  } finally { w.dispose(); }
});

const rawSeed = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SEED ?? "424242";
if (!/^\d+$/.test(rawSeed) || !Number.isSafeInteger(Number(rawSeed)) || Number(rawSeed) > 0xffffffff) {
  throw new Error("SEED must be a uint32 decimal integer");
}
const seed = Number(rawSeed);
test(`multi-document heads preserve atomic groups through offline edits, pinned moves and typed transfer; seed=${seed}`, () => {
  for (let run = 0; run < 8; run++) {
    const w = world();
    let state = (seed + run * 97) >>> 0;
    const next = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 8) % limit; };
    const saved: { at: RevisionSet; state: State; snapshots: readonly TextSnapshot[]; texts: readonly string[] }[] = [];
    try {
      for (let step = 0; step < 32; step++) {
        const index = next(3);
        const head = w.heads[index]!;
        const snapshots = documents.map((document) => head.snapshot(document));
        saved.push({ at: head.checkpoint().revisions, state: clone(w.states[index]!), snapshots, texts: snapshots.map((snapshot) => snapshot.text()) });
        const kind = step < 2 ? 0 : next(5);
        if (kind < 3) {
          const chosen = [...documents];
          for (let i = chosen.length - 1; i > 0; i--) {
            const j = next(i + 1);
            [chosen[i], chosen[j]] = [chosen[j]!, chosen[i]!];
          }
          const count = step < 2 ? 2 : 1 + next(3);
          const commands = chosen.slice(0, count).map((document) => {
            const text = w.models.get(document)!.text([...w.states[index]!.get(document)!]);
            const boundaries = [0];
            for (const scalar of text) boundaries.push(boundaries[boundaries.length - 1]! + scalar.length);
            const low = next(boundaries.length), high = low + next(boundaries.length - low);
            return { document, start: boundaries[low]!, end: boundaries[high]!, text: ["x", "😀", "\u0301", "\r\n", ""][next(5)]! };
          });
          w.commit(index, commands);
        } else {
          const savedIndex = next(saved.length);
          const target = saved[savedIndex]!;
          w.actions.push({ index, kind: kind === 3 ? "merge" : "checkout", savedIndex });
          if (kind === 3) {
            head.merge({ expect: head.checkpoint(), source: target.at });
            for (const document of documents) for (const id of target.state.get(document)!) w.states[index]!.get(document)!.add(id);
          } else {
            head.checkout({ expect: head.checkpoint(), at: target.at });
            w.states[index] = clone(target.state);
          }
        }
        for (let peer = 0; peer < 3; peer++) w.verify(w.store, w.heads[peer]!.checkpoint().revisions, w.states[peer]!);
        if (step % 8 === 7) {
          const captured = saved[next(saved.length)]!;
          const receiver = w.receiver();
          try {
            const before = head.checkpoint();
            const bundle = w.store.exportTyped({ target: captured.at });
            const report = receiver.acceptBundle(JSON.parse(JSON.stringify(bundle)) as NativeHistoryBundle);
            w.verify(receiver, report.availableRevisions, captured.state);
            expect(head.checkpoint()).toBe(before);
          } finally { receiver.dispose(); }
        }
      }
      for (const capture of saved) capture.snapshots.forEach((snapshot, i) => expect(snapshot.text()).toBe(capture.texts[i]));
    } catch (cause) {
      throw new Error(JSON.stringify({ seed, run, actions: w.actions, records: w.records, groups: w.groups }, null, 2), { cause });
    } finally {
      for (const capture of saved) for (const snapshot of capture.snapshots) snapshot.dispose();
      w.dispose();
    }
  }
});
