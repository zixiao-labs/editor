import { expect, test } from "@lightning-js/lightning";
import { SpecReplica, type SpecTransaction } from "./support/replica.js";
import { oracleOrder, minimizeHistory } from "./support/oracle.js";

function accepted(replica: SpecReplica, transaction: SpecTransaction) {
  replica.receive([transaction]);
  return transaction;
}

test("concurrent forward runs stay whole in either delivery order", () => {
  const a = new SpecReplica();
  const b = new SpecReplica();
  const ab = accepted(a, a.edit("a", 0, 0, "ab"));
  const xy = accepted(b, b.edit("b", 0, 0, "xy"));
  a.receive([xy]);
  b.receive([ab]);
  expect(a.text()).toBe("abxy");
  expect(b.text()).toBe("abxy");
  expect(oracleOrder([ab, xy])).toEqual(a.visibleIds());
});

test("backward typing is not split by a concurrent insertion", () => {
  const a = new SpecReplica();
  const b = new SpecReplica();
  const tail = accepted(a, a.edit("a", 0, 0, "b"));
  const front = accepted(a, a.edit("c", 0, 0, "a"));
  const other = accepted(b, b.edit("b", 0, 0, "x"));
  b.receive([front, tail], "defer");
  a.receive([other]);
  expect(a.text()).toBe("abx");
  expect(b.text()).toBe(a.text());
  expect(oracleOrder([tail, front, other])).toEqual(a.visibleIds());
});

test("right-origin list order, not origin ID or arrival order, determines siblings", () => {
  const a = new SpecReplica();
  const b = new SpecReplica();
  const c = new SpecReplica();
  const A = accepted(a, a.edit("a", 0, 0, "A"));
  const B = accepted(b, b.edit("b", 0, 0, "B"));
  const C = accepted(c, c.edit("c", 0, 0, "C"));
  a.receive([C]);
  b.receive([A]);
  const X = accepted(a, a.edit("z", 1, 1, "X"));
  const Y = accepted(b, b.edit("d", 1, 1, "Y"));
  const history = [A, B, C, X, Y];
  c.receive([Y, X], "defer");
  c.receive([A, B]);
  expect(c.text()).toBe("AXYBC");
  expect(oracleOrder(history)).toEqual(c.visibleIds());
  const wrong = new SpecReplica("", { rightOrder: "id-only" });
  wrong.receive(history);
  expect(wrong.text()).toBe("AYXBC");
  expect(wrong.visibleIds()).not.toEqual(oracleOrder(history));
});

test("all legal delivery orders of a small causal graph converge, including duplicates", () => {
  const a = new SpecReplica();
  const b = new SpecReplica();
  const first = accepted(a, a.edit("a", 0, 0, "x"));
  const later = accepted(a, a.edit("c", 1, 1, "y"));
  const concurrent = accepted(b, b.edit("b", 0, 0, "z"));
  let schedules = 0;
  function visit(done: SpecTransaction[], rest: SpecTransaction[]) {
    if (!rest.length) {
      const replica = new SpecReplica();
      for (const tx of done) {
        replica.receive([tx]);
        expect(replica.receive([tx])).toBe("duplicate");
      }
      expect(replica.text()).toBe("xyz");
      expect(replica.visibleIds()).toEqual(oracleOrder(done));
      schedules++;
      return;
    }
    for (const tx of rest) {
      if (tx.depends.every((id) => done.some((known) => known.id === id))) {
        visit([...done, tx], rest.filter((other) => other !== tx));
      }
    }
  }
  visit([], [first, later, concurrent]);
  expect(schedules).toBe(3);
});

test("missing parents reject atomically or defer explicitly; negative control is detected", () => {
  const source = new SpecReplica();
  const parent = accepted(source, source.edit("a", 0, 0, "A"));
  const child = source.edit("b", 1, 1, "B");
  const replica = new SpecReplica();
  expect(() => replica.receive([child])).toThrow("MISSING_DEPENDENCIES");
  expect(replica.revision()).toEqual([]);
  expect(replica.receive([child], "defer")).toBe("pending");
  expect(() => replica.receive([{ ...child, deletes: ["unknown"] }], "defer"))
    .toThrow("IDENTITY_CONFLICT");
  replica.receive([parent]);
  expect(replica.text()).toBe("AB");
  const omissionDetected = () => {
    const mutant = new SpecReplica("", { ignoreMissing: true });
    return mutant.receive([child]) !== "accepted";
  };
  expect(omissionDetected()).toBe(false);
});

test("ID conflicts, cycles, wrong base and dependency-external references cannot partially accept", () => {
  const source = new SpecReplica();
  const first = accepted(source, source.edit("a", 0, 0, "A"));
  const second = source.edit("b", 1, 1, "B");
  const replica = new SpecReplica();
  replica.receive([first]);
  expect(() => replica.receive([{ ...first, deletes: ["unknown"] }])).toThrow("IDENTITY_CONFLICT");
  expect(() => replica.receive([{ ...second, base: "other" }])).toThrow("BASE_MISMATCH");
  expect(() => replica.receive([{ ...second, depends: [] }])).toThrow("INVALID_REFERENCE");
  expect(() => replica.receive([
    { ...first, id: "x", depends: ["y"] },
    { ...second, id: "y", depends: ["x"] },
  ])).toThrow("INVALID_CAUSAL_GRAPH");
  expect(replica.text()).toBe("A");
  expect(replica.revision()).toEqual(["a"]);
});

test("a valid member of a corrupt bundle is not accepted before the whole bundle validates", () => {
  const source = new SpecReplica();
  const first = accepted(source, source.edit("a", 0, 0, "A"));
  const second = source.edit("b", 1, 1, "B");
  const replica = new SpecReplica();
  expect(() => replica.receive([first, { ...second, deletes: ["unknown"] }]))
    .toThrow("INVALID_REFERENCE");
  expect(replica.revision()).toEqual([]);
  expect(replica.text()).toBe("");
});

test("the insertion right origin includes tombstones, not merely the next visible element", () => {
  const replica = new SpecReplica("AB");
  const deletion = accepted(replica, replica.edit("a", 1, 2, ""));
  const insertion = replica.edit("b", 1, 1, "X");
  expect(insertion.inserts[0]!.right).toBe("root/000001");
  replica.receive([insertion]);
  expect(replica.text()).toBe("AX");
  accepted(replica, replica.control("c", deletion.id, false));
  expect(replica.text()).toBe("AXB");
});

test("observed deletes do not consume concurrent inserts; old snapshots and attribution stay fixed", () => {
  const a = new SpecReplica("AB");
  const b = new SpecReplica("AB");
  const before = a.snapshot();
  const deletion = accepted(a, a.edit("a", 0, 2, ""));
  const insertion = accepted(b, b.edit("b", 1, 1, "X"));
  a.receive([insertion]);
  b.receive([deletion]);
  expect(a.text()).toBe("X");
  expect(b.text()).toBe("X");
  expect(before.text).toBe("AB");
  expect(a.snapshot().creators).toEqual(["b"]);
});

test("undo preserves remote descendants and other active deletion tags; redo reuses identities", () => {
  const a = new SpecReplica();
  const original = accepted(a, a.edit("a", 0, 0, "AB"));
  const b = new SpecReplica();
  b.receive([original]);
  const remote = accepted(b, b.edit("b", 1, 1, "X"));
  a.receive([remote]);
  const undo = accepted(a, a.control("c", "a", false));
  expect(a.text()).toBe("X");
  const redo = accepted(a, a.control("d", "a", true));
  expect(a.text()).toBe("AXB");
  expect(a.visibleIds()).toEqual(b.visibleIds());
  b.receive([redo, undo], "defer");
  expect(b.text()).toBe(a.text());

  const one = new SpecReplica("Q");
  const two = new SpecReplica("Q");
  const d1 = accepted(one, one.edit("e", 0, 1, ""));
  const d2 = accepted(two, two.edit("f", 0, 1, ""));
  one.receive([d2]);
  const u1 = accepted(one, one.control("g", "e", false));
  expect(one.text()).toBe("");
  two.receive([d1, u1]);
  expect(two.text()).toBe("");
  accepted(one, one.control("h", "f", false));
  expect(one.text()).toBe("Q");
});

test("stable cut affinity, deleted and not-yet-created use guard identity, not capture frontier", () => {
  const replica = new SpecReplica("AB");
  const before = replica.anchor(1, "before");
  const after = replica.anchor(1, "after");
  const initial = replica.revision();
  accepted(replica, replica.edit("a", 1, 1, "xy"));
  expect(replica.resolve(before)).toEqual({ status: "present", offsetUtf16: 1 });
  expect(replica.resolve(after)).toEqual({ status: "present", offsetUtf16: 3 });
  const newGuard = replica.anchor(2, "after");
  expect(replica.resolve(newGuard, initial).status).toBe("not-yet-created");
  const unrelated = replica.anchor(1, "before");
  expect(replica.resolve(unrelated, initial).status).toBe("present");
  accepted(replica, replica.edit("b", 0, 1, ""));
  expect(replica.resolve(before)).toEqual({
    status: "deleted", beforeUtf16: 0, afterUtf16: 0,
  });
});

test("Unicode scalars and exact EOL survive; surrogate interiors and malformed strings reject", () => {
  const replica = new SpecReplica("A😀e\u0301\r\nB");
  expect(() => replica.edit("a", 2, 3, "")).toThrow("INVALID_BOUNDARY");
  expect(() => replica.edit("a", 0, 0, "\ud800")).toThrow("INVALID_UNICODE");
  accepted(replica, replica.edit("a", 4, 5, ""));
  expect(replica.text()).toBe("A😀e\r\nB");
  expect(replica.resolve(replica.anchor(5, "before")).status).toBe("present");
});

test("same stream ordering must not imply causal prefix or leak an isolated edit", () => {
  const replica = new SpecReplica();
  const secret = accepted(replica, replica.edit("stream:1", 0, 0, "secret"));
  const publicEdit = replica.edit("stream:2", 0, 0, "public", []);
  expect(publicEdit.depends).toEqual([]);
  const remote = new SpecReplica();
  remote.receive([publicEdit]);
  expect(remote.text()).toBe("public");
  expect(remote.revision()).not.toContain(secret.id);
});

test("tie-order negative control and causal shrinker detect and reduce a real counterexample", () => {
  const a = new SpecReplica();
  const b = new SpecReplica();
  const A = a.edit("a", 0, 0, "A");
  const B = b.edit("b", 0, 0, "B");
  const broken = new SpecReplica("", { reverseTies: true });
  broken.receive([A, B]);
  expect(broken.visibleIds()).not.toEqual(oracleOrder([A, B]));
  const noise = b.edit("z", 0, 0, "");
  const fails = (history: readonly SpecTransaction[]) => {
    const mutant = new SpecReplica("", { reverseTies: true });
    mutant.receive(history);
    return mutant.visibleIds().join() !== oracleOrder(history).join();
  };
  expect(minimizeHistory([noise, A, B], fails).map((tx) => tx.id)).toEqual(["a", "b"]);
});
