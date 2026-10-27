import { expect, test } from "@lightning-js/lightning";
import { SpecReplica, type SpecTransaction } from "./support/replica.js";
import { minimizeHistory, oracleOrder } from "./support/oracle.js";

const environment = (globalThis as {
  process?: { env: Record<string, string | undefined> };
}).process?.env;
const rawSeed = environment?.SEED ?? "424242";
if (!/^\d+$/.test(rawSeed) || !Number.isSafeInteger(Number(rawSeed)) ||
  Number(rawSeed) > 0xffffffff) throw new Error("SEED must be a uint32 decimal integer");
const seed = Number(rawSeed);

function random(seed: number) {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
}

function shuffled<T>(values: readonly T[], next: (limit: number) => number): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = next(i + 1);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

test(`three offline replicas reconnect with exact history; seed=${seed}`, () => {
  // Multiple independent histories, not only multiple schedules of one graph.
  for (let run = 0; run < 16; run++) {
    const next = random((seed + run) >>> 0);
    const replicas = [new SpecReplica("A😀\r\n"), new SpecReplica("A😀\r\n"), new SpecReplica("A😀\r\n")];
    const history: SpecTransaction[] = [];
    const checkpoints: { replica: SpecReplica; at: readonly string[]; text: string }[] = [];
    try {
      for (let step = 0; step < 24; step++) {
        const replica = replicas[next(3)]!;
        const before = replica.text();
        const offsets = [0];
        for (const scalar of before) offsets.push(offsets[offsets.length - 1]! + scalar.length);
        const low = next(offsets.length);
        const high = low + next(offsets.length - low);
        const choices = ["x", "😀", "\u0301", "\r\n", ""];
        const inserted = choices[next(choices.length)]!;
        const tx = replica.edit(`tx:${String(step).padStart(3, "0")}`, offsets[low]!, offsets[high]!, inserted);
        replica.receive([tx]);
        history.push(tx);
        // A simple string oracle is valid HERE because this is one local edit.
        expect(replica.text()).toBe(before.slice(0, offsets[low]) + inserted + before.slice(offsets[high]));
        checkpoints.push({ replica, at: replica.revision(), text: replica.text() });
        if (next(4) === 0) {
          const peer = replicas[next(3)]!;
          replica.receive(shuffled(peer.history(), next));
        }
      }
      const replay = new SpecReplica("A😀\r\n");
      for (const tx of shuffled(history, next)) {
        replay.receive([tx], "defer");
        replay.receive([tx], "defer");
      }
      for (const replica of replicas) {
        replica.receive(shuffled(history, next));
        expect(replica.text()).toBe(replay.text());
        expect(replica.visibleIds()).toEqual(replay.visibleIds());
        expect(replica.snapshot().creators).toEqual(replay.snapshot().creators);
      }
      for (const checkpoint of checkpoints) {
        expect(checkpoint.replica.text(checkpoint.at)).toBe(checkpoint.text);
      }
    } catch (cause) {
      throw new Error(JSON.stringify({ seed, run, history, checkpoints: checkpoints.map(({ at, text }) =>
        ({ at, text })) }, null, 2), { cause });
    }
  }
});

test(`tiny generated histories agree with the independent all-orders oracle; seed=${seed}`, () => {
  for (let run = 0; run < 12; run++) {
    const next = random((seed + run * 97) >>> 0);
    const replicas = [new SpecReplica(), new SpecReplica(), new SpecReplica()];
    const history: SpecTransaction[] = [];
    for (let step = 0; step < 6; step++) {
      const replica = replicas[next(3)]!;
      if (next(2)) replica.receive(replicas[next(3)]!.history());
      const offset = next(replica.text().length + 1);
      const tx = replica.edit(`n${step}`, offset, offset, String.fromCharCode(65 + step));
      replica.receive([tx]);
      history.push(tx);
    }
    const differs = (transactions: readonly SpecTransaction[]) => {
      const replay = new SpecReplica();
      replay.receive(transactions);
      return replay.visibleIds().join() !== oracleOrder(transactions).join();
    };
    if (differs(history)) {
      throw new Error(JSON.stringify({ seed, run, counterexample: minimizeHistory(history, differs) }, null, 2));
    }
    expect(differs(history)).toBe(false);
  }
});
