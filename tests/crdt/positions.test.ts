import { expect, test } from "@lightning-js/lightning";
import { SourceRevision } from "../../src/model/source-revision.js";
import { documentId, revisionId } from "../../src/identity.js";
import type { Affinity, PositionResolution, StablePosition } from "../../src/contracts/core.js";
import { SpecReplica, type SpecTransaction } from "./support/replica.js";
import { minimizeHistory, oracleOrder } from "./support/oracle.js";

const document = documentId("position-differential");
const environment = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
const rawSeed = environment?.SEED ?? "424242";
if (!/^\d+$/.test(rawSeed) || !Number.isSafeInteger(Number(rawSeed)) || Number(rawSeed) > 0xffffffff) {
  throw new Error("SEED must be a uint32 decimal integer");
}
const seed = Number(rawSeed);

type Mutation = "swap-affinity" | "discard-tombstones";
type NumericResolution =
  | { status: "present"; offsetUtf16: number }
  | { status: "deleted"; beforeUtf16: number; afterUtf16: number }
  | { status: "not-yet-created" };

function numeric(source: SourceRevision, result: PositionResolution): NumericResolution {
  const offset = (position: StablePosition): number => {
    const repair = source.resolve(position);
    if (repair.status !== "present") throw new Error("Repair must be present");
    return repair.point.offset;
  };
  switch (result.status) {
    case "present": return { status: "present", offsetUtf16: result.point.offset };
    case "not-yet-created": return { status: "not-yet-created" };
    case "deleted": return { status: "deleted", beforeUtf16: offset(result.before), afterUtf16: offset(result.after) };
  }
}

function checkHistory(history: readonly SpecTransaction[], mutation?: Mutation): Set<string> {
  const cuts: { model: SpecReplica; source: SourceRevision; included: readonly string[] }[] = [];
  // Exhaust causal subsets, not only a single forward delivery sequence.
  for (let mask = 0; mask < 2 ** history.length; mask++) {
    const selected = history.filter((_, i) => mask & (1 << i));
    if (selected.some((tx) => tx.depends.some((id) => !selected.some((other) => other.id === id)))) continue;
    const model = new SpecReplica();
    model.receive(selected);
    const visible = new Set(model.visibleIds());
    const values = new Map(selected.flatMap((tx) => tx.inserts.map((node) => [node.id, node.value] as const)));
    // The adapter does NOT inspect parent/side or copy the model's traversal.
    // The independent factorial oracle provides full order; the model supplies
    // visibility. This tests the production position/index layer, not a
    // production CRDT, transaction validator, codec, or replica implementation.
    const elements = oracleOrder(selected).map((id) => ({
      id, scalar: values.get(id)!, visible: visible.has(id),
    })).filter((element) => mutation !== "discard-tombstones" || element.visible);
    const source = new SourceRevision({
      document, root: "position-test-root", revision: revisionId(`cut:${mask}`), elements,
    });
    const snapshot = source.snapshot();
    expect(snapshot.text()).toBe(model.text());
    snapshot.dispose();
    cuts.push({ model, source, included: model.revision() });
  }
  const statuses = new Set<string>();
  for (const capture of cuts) {
    const snapshot = capture.source.snapshot();
    let offset = 0;
    const boundaries = [offset];
    for (const scalar of snapshot.text()) boundaries.push(offset += scalar.length);
    for (const boundary of boundaries) {
      for (const affinity of ["before", "after"] as const) {
        const modelAnchor = capture.model.anchor(boundary, affinity);
        const actualAffinity: Affinity = mutation === "swap-affinity"
          ? affinity === "before" ? "after" : "before" : affinity;
        const position = snapshot.anchorUtf16(boundary, { affinity: actualAffinity });
        for (const target of cuts) {
          const expected = target.model.resolve(modelAnchor);
          const actual = numeric(target.source, target.source.resolve(position));
          if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`POSITION_MISMATCH ${JSON.stringify({
              from: capture.included, to: target.included, boundary, affinity, expected, actual,
            })}`);
          }
          statuses.add(actual.status);
        }
      }
    }
    snapshot.dispose();
  }
  return statuses;
}

function hasPositionMismatch(history: readonly SpecTransaction[], mutation?: Mutation): boolean {
  try {
    checkHistory(history, mutation);
    return false;
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("POSITION_MISMATCH")) return true;
    throw cause; // Do not shrink an unrelated adapter/oracle error as a mismatch.
  }
}

function fixture(): SpecTransaction[] {
  const a = new SpecReplica();
  const b = new SpecReplica();
  const c = new SpecReplica();
  const history: SpecTransaction[] = [];
  const accept = (replica: SpecReplica, tx: SpecTransaction): SpecTransaction => {
    replica.receive([tx]);
    history.push(tx);
    return tx;
  };
  const first = accept(a, a.edit("a", 0, 0, "A"));
  const emoji = accept(b, b.edit("b", 0, 0, "😀"));
  a.receive([emoji]);
  accept(a, a.edit("c", 1, 1, "中"));
  b.receive(a.history());
  const deletion = accept(b, b.edit("d", 0, 1, ""));
  c.receive([first]);
  accept(c, c.edit("e", 1, 1, "e\u0301"));
  accept(b, b.control("f", deletion.id, false));
  return history;
}

test("production positions agree with model resolution across every causal cut, including undo visibility", () => {
  const statuses = checkHistory(fixture());
  expect([...statuses].sort()).toEqual(["deleted", "not-yet-created", "present"]);
});

test("position differential detects wrong affinity and discarded tombstones as negative controls", () => {
  for (const mutation of ["swap-affinity", "discard-tombstones"] as const) {
    const history = fixture();
    expect(() => checkHistory(history, mutation)).toThrow("POSITION_MISMATCH");
    const counterexample = minimizeHistory(history, (candidate) => hasPositionMismatch(candidate, mutation));
    expect(counterexample.length < history.length).toBe(true);
    expect(() => checkHistory(counterexample, mutation)).toThrow("POSITION_MISMATCH");
  }
});

test(`seeded position differential preserves Unicode and historical guards; seed=${seed}`, () => {
  let state = seed;
  const next = (limit: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
  for (let run = 0; run < 12; run++) {
    const replicas = [new SpecReplica(), new SpecReplica(), new SpecReplica()];
    const history: SpecTransaction[] = [];
    for (let step = 0; step < 6; step++) {
      const replica = replicas[next(3)]!;
      if (next(2)) replica.receive(replicas[next(3)]!.history());
      const offsets = [0];
      for (const scalar of replica.text()) offsets.push(offsets[offsets.length - 1]! + scalar.length);
      const low = next(offsets.length);
      const high = low + next(offsets.length - low);
      const scalar = ["A", "😀", "\u0301", "\r", "\n", "中", ""][next(7)]!;
      const tx = replica.edit(`t:${step}`, offsets[low]!, offsets[high]!, scalar);
      replica.receive([tx]);
      history.push(tx);
    }
    try {
      checkHistory(history);
    } catch (cause) {
      const counterexample = minimizeHistory(history, (candidate) => hasPositionMismatch(candidate));
      throw new Error(JSON.stringify({ seed, run, history, counterexample }, null, 2), { cause });
    }
  }
});
