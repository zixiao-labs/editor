import { expect, test } from "@lightning-js/lightning";
import { documentId, revisionId } from "../../src/identity.js";
import type { Affinity, StablePosition } from "../../src/contracts/core.js";
import { SourceRevision, type SourceElement } from "../../src/model/source-revision.js";

const document = documentId("test:document");
const root = "test:root";
const element = (id: string, scalar: string, visible = true): SourceElement => ({ id, scalar, visible });
function view(name: string, elements: readonly SourceElement[]): SourceRevision {
  return new SourceRevision({ document, root, revision: revisionId(name), elements });
}
function pointOffset(source: SourceRevision, position: StablePosition): number {
  const result = source.resolve(position);
  if (result.status !== "present") throw new Error(`Expected present; got ${result.status}`);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.point)).toBe(true);
  expect(result.point.document).toBe(document);
  expect(result.point.revision).toBe(source.revision);
  expect(result.point.unit).toBe("utf16");
  return result.point.offset;
}

test("source snapshots bind points and ranges to one immutable revision", () => {
  const source = view("old", [element("a", "A"), element("emoji", "😀"), element("b", "B")]);
  const snapshot = source.snapshot();
  expect(snapshot.document).toBe(document);
  expect(snapshot.revision).toBe(revisionId("old"));
  expect(snapshot.lengthUtf16).toBe(4);
  expect(snapshot.pointUtf16(3)).toEqual({ document, revision: revisionId("old"), unit: "utf16", offset: 3 });
  expect(snapshot.convertPoint(snapshot.pointUtf8(5), "scalar").offset).toBe(2);
  expect(snapshot.convertPoint(snapshot.pointScalar(3), "utf16").offset).toBe(4);
  expect(snapshot.rangeUtf16(1, 3)).toEqual({
    document, revision: revisionId("old"), unit: "utf16", start: 1, end: 3,
  });
  expect(() => snapshot.rangeUtf16(3, 1)).toThrow("INVALID_RANGE");
  expect(() => snapshot.rangeUtf16(1, 2)).toThrow("INVALID_BOUNDARY");
  expect(() => snapshot.anchorUtf16(2, { affinity: "before" })).toThrow("INVALID_BOUNDARY");
  expect(() => snapshot.convertPoint({ ...snapshot.pointUtf16(0), revision: revisionId("new") }, "scalar"))
    .toThrow("WRONG_REVISION");
  expect(() => snapshot.convertPoint({ ...snapshot.pointUtf16(0), document: documentId("other") }, "scalar"))
    .toThrow("WRONG_REVISION");
  expect(() => snapshot.convertPoint({ ...snapshot.pointUtf16(0), offset: 2 }, "utf16"))
    .toThrow("INVALID_BOUNDARY");
  expect(() => snapshot.anchorUtf16(0, { affinity: "other" as Affinity })).toThrow("INVALID_REFERENCE");
  const next = view("new", [element("a", "A"), element("x", "X"), element("emoji", "😀"), element("b", "B")]);
  expect(next.snapshot().text()).toBe("AX😀B");
  expect(snapshot.text()).toBe("A😀B");
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.pointUtf16(0))).toBe(true);
  expect(Object.isFrozen(snapshot.rangeUtf16(0, 4))).toBe(true);
});

test("materialization inputs are copied, validated and never become mutable snapshot aliases", () => {
  const elements = [element("a", "A"), element("b", "B")];
  const input = { document, root, revision: revisionId("old"), elements };
  const source = new SourceRevision(input);
  const snapshot = source.snapshot();
  const cut = snapshot.anchorUtf16(1, { affinity: "after" });
  Object.assign(elements[1]!, { scalar: "C", id: "changed", visible: false });
  elements.length = 0;
  input.root = "changed-root";
  input.revision = revisionId("changed-revision");
  expect(snapshot.text()).toBe("AB");
  expect(pointOffset(source, cut)).toBe(1);
  expect(snapshot.revision).toBe(revisionId("old"));
  expect(Object.isFrozen(source)).toBe(true);
  for (const invalid of ["", "ab", "\ud800"]) {
    expect(() => view("bad", [element("a", invalid)])).toThrow("INVALID_UNICODE");
  }
  expect(() => view("bad", [element("a", "A"), element("a", "B")])).toThrow("INVALID_REFERENCE");
  expect(() => view("bad", [element("", "A")])).toThrow("INVALID_REFERENCE");
});

test("stable cuts preserve before/after affinity and sentinel identity across insertions", () => {
  const base = view("base", [element("a", "A"), element("b", "B")]);
  const snapshot = base.snapshot();
  const left = snapshot.anchorUtf16(1, { affinity: "before" });
  const right = snapshot.anchorUtf16(1, { affinity: "after" });
  const next = view("inserted", [element("a", "A"), element("x", "😀"), element("y", "中"), element("b", "B")]);
  expect(pointOffset(next, left)).toBe(1);
  expect(pointOffset(next, right)).toBe(4);
  const empty = view("empty", []).snapshot();
  expect(pointOffset(next, empty.anchorUtf16(0, { affinity: "before" }))).toBe(0);
  expect(pointOffset(next, empty.anchorUtf16(0, { affinity: "after" }))).toBe(5);
  const range = snapshot.stableRangeUtf16(0, 2, { startAffinity: "before", endAffinity: "after" });
  expect(Object.isFrozen(range)).toBe(true);
  expect(Object.isFrozen(range.start)).toBe(true);
  expect(pointOffset(next, range.start)).toBe(0);
  expect(pointOffset(next, range.end)).toBe(5);
  snapshot.dispose();
  // Positions are immutable values, not borrowed snapshot handles.
  expect(pointOffset(next, right)).toBe(4);
});

test("deleted guards repair from full order and preserve two distinct future affinities", () => {
  const base = view("base", [element("a", "A"), element("b", "😀"), element("c", "C")]);
  const cut = base.snapshot().anchorUtf16(1, { affinity: "after" });
  const hidden = view("hidden", [element("a", "A"), element("b", "😀", false),
    element("hidden", "h", false), element("x", "中"), element("c", "C")]);
  const result = hidden.resolve(cut);
  expect(result.status).toBe("deleted");
  if (result.status !== "deleted") throw new Error("Expected deleted");
  expect(Object.isFrozen(result)).toBe(true);
  expect(pointOffset(hidden, result.before)).toBe(1);
  expect(pointOffset(hidden, result.after)).toBe(1);
  const later = view("repaired", [element("a", "A"), element("b", "😀", false),
    element("hidden", "h", false), element("new", "😀"), element("x", "中"), element("c", "C")]);
  expect(pointOffset(later, result.before)).toBe(1);
  expect(pointOffset(later, result.after)).toBe(3);
  // Resolving a repair never rewrites the original token.
  expect(later.resolve(cut).status).toBe("deleted");
  const restored = view("restored", [element("a", "A"), element("b", "😀"), element("c", "C")]);
  expect(pointOffset(restored, cut)).toBe(1);
});

test("deleting all guards repairs to START/END without losing the original identities", () => {
  const original = view("original", [element("a", "😀")]).snapshot();
  const cuts = [
    original.anchorUtf16(0, { affinity: "after" }),
    original.anchorUtf16(2, { affinity: "before" }),
  ];
  const hidden = view("empty-visible", [element("a", "😀", false)]);
  const later = view("later", [element("x", "中"), element("a", "😀", false)]);
  for (const cut of cuts) {
    const result = hidden.resolve(cut);
    if (result.status !== "deleted") throw new Error("Expected deleted");
    expect(pointOffset(hidden, result.before)).toBe(0);
    expect(pointOffset(hidden, result.after)).toBe(0);
    expect(pointOffset(later, result.before)).toBe(0);
    expect(pointOffset(later, result.after)).toBe(1);
    expect(later.resolve(cut).status).toBe("deleted");
  }
  expect(() => original.stableRangeUtf16(2, 0, { startAffinity: "before", endAffinity: "after" }))
    .toThrow("INVALID_RANGE");
});

test("positions distinguish absent guards, hidden guards, wrong roots and forged tokens", () => {
  const base = view("base", [element("a", "A")]);
  const inserted = view("inserted", [element("a", "A"), element("x", "X"), element("other", "Z")]);
  const cut = inserted.snapshot().anchorUtf16(1, { affinity: "after" });
  expect(base.resolve(cut)).toEqual({ status: "not-yet-created" });
  // Capture revision's unrelated element is not a dependency of the position.
  expect(pointOffset(view("without-unrelated", [element("a", "A"), element("x", "X")]), cut)).toBe(1);
  expect(view("hidden", [element("a", "A"), element("x", "X", false)]).resolve(cut).status).toBe("deleted");
  const wrongRoot = new SourceRevision({ document, root: "other", revision: revisionId("other"), elements: [] });
  expect(() => wrongRoot.resolve(cut)).toThrow("BASE_MISMATCH");
  const wrongDocument = new SourceRevision({
    document: documentId("other"), root, revision: revisionId("other"), elements: [],
  });
  expect(() => wrongDocument.resolve(cut)).toThrow("INVALID_REFERENCE");
  expect(() => base.resolve({} as StablePosition)).toThrow("INVALID_REFERENCE");
  expect(() => base.resolve({ ...cut } as StablePosition)).toThrow("INVALID_REFERENCE");
});

test("translation validates the source point and resolves exactly in the requested target revision", () => {
  const base = view("base", [element("a", "A"), element("b", "B")]);
  const target = view("target", [element("a", "A"), element("x", "😀"), element("b", "B")]);
  const point = base.snapshot().pointUtf8(1);
  expect(base.translate(point, target, "before")).toEqual({
    status: "present", point: { document, revision: revisionId("target"), unit: "utf16", offset: 1 },
  });
  expect(base.translate(point, target, "after")).toEqual({
    status: "present", point: { document, revision: revisionId("target"), unit: "utf16", offset: 3 },
  });
  expect(() => target.translate(point, base, "after")).toThrow("WRONG_REVISION");
  expect(() => base.translate({ ...point, offset: 0.5 }, target, "after")).toThrow("INVALID_RANGE");
});

test("snapshot disposal is idempotent, rejects every operation and leaves copied values intact", () => {
  const source = view("base", [element("a", "A"), element("b", "B")]);
  const snapshot = source.snapshot();
  const text = snapshot.text();
  const point = snapshot.pointUtf16(1);
  const cut = snapshot.anchorUtf16(1, { affinity: "before" });
  snapshot.dispose();
  snapshot.dispose();
  const operations = [
    () => snapshot.text(), () => snapshot.pointUtf16(0), () => snapshot.pointUtf8(0),
    () => snapshot.pointScalar(0), () => snapshot.convertPoint(point, "utf8"),
    () => snapshot.rangeUtf16(0, 0), () => snapshot.anchorUtf16(0, { affinity: "before" }),
    () => snapshot.stableRangeUtf16(0, 0, { startAffinity: "before", endAffinity: "after" }),
  ];
  for (const operation of operations) expect(operation).toThrow("DISPOSED");
  expect(text).toBe("AB");
  expect(point.offset).toBe(1);
  expect(pointOffset(source, cut)).toBe(1);
  // Each snapshot is a separate resource.
  expect(source.snapshot().text()).toBe("AB");
});

test("large materializations avoid recursive traversal and preserve long tombstone gaps", () => {
  const elements: SourceElement[] = [];
  for (let i = 0; i < 30_000; i++) elements.push(element(`e:${i}`, "😀", i === 0 || i === 29_999));
  const source = view("large", elements);
  const snapshot = source.snapshot();
  expect(snapshot.text()).toBe("😀😀");
  expect(snapshot.pointUtf8(4).offset).toBe(4);
  const origin = view("origin", elements.map((item) => ({ ...item, visible: true }))).snapshot();
  const cut = origin.anchorUtf16(30_000, { affinity: "after" });
  const result = source.resolve(cut);
  if (result.status !== "deleted") throw new Error("Expected deleted");
  expect(pointOffset(source, result.before)).toBe(2);
  expect(pointOffset(source, result.after)).toBe(2);
});
