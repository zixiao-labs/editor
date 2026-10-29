import { expect, test } from "@lightning-js/lightning";
import { NativeHistory, type NativeTransaction } from "../../src/history/native-history.js";
import { NativeStore } from "../../src/history/native-store.js";
import { NativeWriter } from "../../src/history/identity.js";
import { createManifest } from "../../src/history/transaction-group.js";
import { actorId, documentId, externalBaseId, replicaId, type RevisionId } from "../../src/identity.js";
import { SpecReplica, type SpecTransaction } from "./support/replica.js";

const document = documentId("activity:a"), other = documentId("activity:b"), base = externalBaseId("activity:base");

/** Representation adapter only. Control IDs name the shared representative op;
 * no production order/visibility/winner calculation is reused by the model. */
function model(transactions: readonly NativeTransaction[], root: string, initial: string, wrongOwnId = false) {
  const byId = new Map(transactions.map((tx) => [tx.id, tx]));
  const modelId = (tx: NativeTransaction) => tx.control && !wrongOwnId ? `control:${tx.control.order}|${tx.id}` : tx.id;
  const names = new Map<string, string>([["^", "^"], ["$", "$"]]);
  let ordinal = 0;
  for (const _ of initial) names.set(`${root}/${(ordinal).toString(16).padStart(8, "0")}`, `root/${String(ordinal++).padStart(6, "0")}`);
  for (const tx of transactions) {
    let inserted = 0;
    for (const effect of tx.effects) if (effect.kind === "insert") names.set(effect.id, `${tx.id}/${String(inserted++).padStart(6, "0")}`);
  }
  const history: SpecTransaction[] = transactions.map((tx) => {
    const selected = new Set<NativeTransaction["id"]>(), pending = [...tx.depends];
    while (pending.length) {
      const id = pending.pop()!;
      if (selected.has(id)) continue;
      selected.add(id);
      for (const dependency of byId.get(id)!.depends) pending.push(dependency);
    }
    return {
      id: modelId(tx), base: initial, depends: [...selected].map((id) => modelId(byId.get(id)!)),
      inserts: tx.effects.flatMap((effect) => effect.kind === "insert" ? [{
        id: names.get(effect.id)!, value: effect.scalar, parent: names.get(effect.parent)!, side: effect.side,
        left: names.get(effect.left)!, right: names.get(effect.right)!, creator: tx.id,
      }] : []),
      deletes: tx.effects.flatMap((effect) => effect.kind === "delete" ? effect.targets.map((id) => names.get(id)!) : []),
      ...(tx.control ? { control: { group: tx.control.member, generation: tx.control.generation, active: tx.control.active } } : {}),
    };
  });
  const replica = new SpecReplica(initial);
  replica.receive(history);
  return { replica, names };
}

const rawSeed = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SEED ?? "424242";
if (!/^\d+$/.test(rawSeed) || Number(rawSeed) > 0xffffffff) throw new Error("SEED must be a uint32 decimal integer");
const seed = Number(rawSeed);
test(`activity registers match independent replay across isolated edits, controls, joins and old cuts; seed=${seed}`, () => {
  for (let run = 0; run < 8; run++) {
    const initial = "A😀\r\n";
    const h = new NativeHistory({ document, base, text: initial });
    const writer = new NativeWriter({ actor: actorId("owner"), replica: replicaId("replica"), random: { fill(bytes) { bytes.fill(1); } } });
    let random = (seed + run * 97) >>> 0;
    const next = (limit: number) => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return (random >>> 8) % limit; };
    const heads: RevisionId[] = [h.initial, h.initial, h.initial];
    const old: { at: RevisionId; text: string }[] = [];
    const actions: unknown[] = [];
    try {
      for (let step = 0; step < 32; step++) {
        const site = next(3), at = heads[site]!;
        const expected = model(h.transactions(at), h.root.id, initial).replica;
        old.push({ at, text: expected.text() });
        const originals = h.transactions(at).filter((tx) => !tx.control);
        if (originals.length && next(3) === 0) {
          const member = originals[next(originals.length)]!.id, active = next(2) === 1;
          actions.push({ site, at, member, active });
          const tx = h.prepareControl({ at, writer, member, active });
          h.accept([tx]); heads[site] = h.revision([tx.id]);
        } else if (next(4) === 0) {
          const peer = heads[next(3)]!;
          actions.push({ site, at, join: peer }); heads[site] = h.join(at, peer);
        } else {
          const offsets = [0];
          for (const scalar of expected.text()) offsets.push(offsets[offsets.length - 1]! + scalar.length);
          const low = next(offsets.length), high = low + next(offsets.length - low);
          const text = ["x", "😀", "\u0301", "\r\n", ""][next(5)]!;
          actions.push({ site, at, low, high, text });
          const snapshot = h.source(at).snapshot();
          const tx = h.prepare({ at, writer, origin: { kind: "activity-differential" },
            edits: [{ range: snapshot.rangeUtf16(offsets[low]!, offsets[high]!), text }] });
          snapshot.dispose();
          if (tx) { h.accept([tx]); heads[site] = h.revision([tx.id]); }
        }
        for (const revision of heads) {
          const oracle = model(h.transactions(revision), h.root.id, initial);
          expect(h.text(revision).toString()).toBe(oracle.replica.text());
          const visible = h.elements(revision).filter((element) => element.visible);
          expect(visible.map((element) => oracle.names.get(element.id))).toEqual(oracle.replica.visibleIds());
          expect(visible.map((element) => element.transaction ?? "root")).toEqual(oracle.replica.snapshot().creators);
        }
      }
      for (const saved of old) expect(h.text(saved.at).toString()).toBe(saved.text);
      const transferred = new NativeHistory({ document, base, text: initial });
      const joined = h.join(h.join(heads[0]!, heads[1]!), heads[2]!);
      transferred.accept([...h.transactions(joined)].reverse());
      expect(transferred.text(transferred.revision(h.frontier(joined))).toString()).toBe(h.text(joined).toString());
    } catch (cause) {
      throw new Error(JSON.stringify({ seed, run, actions, heads }, null, 2), { cause });
    }
  }
});

test("a control group shares one tie key even when per-document controller ID order disagrees; own-ID mutant fails", () => {
  const sender = new NativeStore({ random: { fill(bytes) { bytes.fill(1); } } });
  const initial = [document, other].map((id) => sender.createDocument({ id, base: { id: base, text: "" } }));
  const writer = sender.openWriter({ actor: actorId("owner"), replica: replicaId("replica") });
  const head = sender.fork({ at: sender.revisions(initial), writer });
  const original = head.commit({ expect: head.checkpoint(), origin: { kind: "test" },
    edits: [document, other].map((document) => {
      const snapshot = head.snapshot(document);
      try { return { document, range: snapshot.rangeUtf16(0, 0), text: "X" }; } finally { snapshot.dispose(); }
    }) });
  const baseBundle = sender.exportTyped({ target: original.after.revisions });
  const peer = sender.fork({ at: original.after.revisions, writer });
  const U = sender.setGroupActive({ head, expect: head.checkpoint(), group: original.groups[0]!, active: false });
  const V = sender.setGroupActive({ head: peer, expect: peer.checkpoint(), group: original.groups[0]!, active: true });
  const u = sender.exportTyped({ target: U.change.after.revisions }).histories.map((history) => history.transactions.find((tx) => tx.control)!);
  const v = sender.exportTyped({ target: V.change.after.revisions }).histories.map((history) => history.transactions.find((tx) => tx.control)!);
  const controller = (templates: typeof u, ids: readonly NativeTransaction["id"][]) => {
    const manifest = createManifest(baseBundle.histories.map((history, i) => ({
      document: history.document, base, root: history.root, transaction: ids[i]!, before: templates[i]!.depends, after: [ids[i]!],
    })));
    const transactions = templates.map((tx, i) => ({
      ...tx, id: ids[i]!, group: manifest.id, control: { ...tx.control!, order: ids[0]! },
    }));
    return { manifest, transactions };
  };
  const undo = controller(u, [u[0]!.id, v[1]!.id]);
  const redo = controller(v, [u[1]!.id, v[0]!.id]);
  const receiver = new NativeStore();
  initial.forEach((entry) => receiver.createDocument({ id: entry.document, base: { id: base, text: "" } }));
  const report = receiver.acceptBundle({
    manifests: [...baseBundle.manifests, undo.manifest, redo.manifest],
    histories: baseBundle.histories.map((history, i) => ({ ...history, transactions: [...history.transactions, undo.transactions[i]!, redo.transactions[i]!] })),
    target: baseBundle.target.map((target, i) => ({ ...target, frontier: [undo.transactions[i]!.id, redo.transactions[i]!.id] })),
  });
  for (let i = 0; i < initial.length; i++) {
    const snapshot = receiver.snapshot({ document: initial[i]!.document, revision: report.availableRevisions.get(initial[i]!.document) });
    expect(snapshot.text()).toBe("X"); snapshot.dispose();
    const transactions = [...baseBundle.histories[i]!.transactions, undo.transactions[i]!, redo.transactions[i]!];
    expect(model(transactions, baseBundle.histories[i]!.root, "").replica.text()).toBe("X");
    if (i === 1) expect(model(transactions, baseBundle.histories[i]!.root, "", true).replica.text()).toBe("");
  }
  head.dispose(); peer.dispose(); writer.dispose(); sender.dispose(); receiver.dispose();
});
