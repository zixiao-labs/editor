import { expect, test } from "@lightning-js/lightning";
import type { TextUnit } from "../../src/contracts/core.js";
import { TextRope, CHUNK_MAX, type TextSummary } from "../../src/text/rope.js";
import type { SumNode } from "../../src/collections/sum-tree.js";

function summary(text: string): TextSummary {
  const lines = text.split(/\r\n|\r|\n/);
  const longest = Math.max(...lines.map((line) => line.length));
  return {
    utf16: text.length, utf8: encodeURIComponent(text).replace(/%[0-9a-f]{2}/gi, "x").length,
    scalars: [...text].length, lineBreaks: lines.length - 1,
    firstLineUtf16: lines[0]!.length, lastLineUtf16: lines[lines.length - 1]!.length,
    longestLineUtf16: longest, longestRow: lines.findIndex((line) => line.length === longest),
    startsWithLf: text.startsWith("\n"), endsWithCr: text.endsWith("\r"),
  };
}
function check(rope: TextRope, text: string): void {
  expect(rope.toString()).toBe(text);
  expect(rope.summary).toEqual(summary(text));
  let previous = "";
  for (const chunk of rope.chunks()) {
    expect(chunk.length > 0 && chunk.length <= CHUNK_MAX).toBe(true);
    if (previous) expect(previous.length + chunk.length > CHUNK_MAX).toBe(true);
    previous = chunk;
  }
}
function nodeSet<T, S>(node: SumNode<T, S> | null): Set<object> {
  const result = new Set<object>();
  const visit = (node: SumNode<T, S>) => {
    result.add(node);
    if (node.kind === "branch") for (const child of node.children) visit(child);
  };
  if (node) visit(node);
  return result;
}

test("rope summaries compose across chunk boundaries, including CRLF and longest-line ties", () => {
  const samples = ["", "A😀e\u0301\r\n中", "\r\n\r\n", "\nabc\rdef", "ab\r\ncd", "x".repeat(CHUNK_MAX - 1) + "\r\n😀"];
  for (const text of samples) {
    check(TextRope.from(text), text);
    const boundaries = [0];
    for (const scalar of text) boundaries.push(boundaries[boundaries.length - 1]! + scalar.length);
    for (const point of boundaries) {
      const left = TextRope.from(text.slice(0, point));
      const right = TextRope.from(text.slice(point));
      check(left.concat(right), text);
    }
  }
  // Force genuine cross-item composition (short ropes would be coalesced into
  // one chunk). Check both parenthesizations and earliest longest-row ties.
  const a = "\r".repeat(CHUNK_MAX);
  const b = "\n" + "x".repeat(CHUNK_MAX - 2) + "\r";
  const c = "\n" + "y".repeat(CHUNK_MAX - 2) + "\n";
  check(TextRope.from(a).concat(TextRope.from(b)).concat(TextRope.from(c)), a + b + c);
  check(TextRope.from(a).concat(TextRope.from(b).concat(TextRope.from(c))), a + b + c);
});

test("rope conversion seeks summaries and rejects UTF-16/UTF-8 interior boundaries without flattening", () => {
  const text = "A😀中e\u0301\r\n".repeat(400);
  const rope = TextRope.from(text);
  let utf16 = 0;
  let utf8 = 0;
  let scalar = 0;
  for (const value of text) {
    for (const [unit, offset] of [["utf16", utf16], ["utf8", utf8], ["scalar", scalar]] as const) {
      expect(rope.scalarAt(offset, unit)).toBe(scalar);
      expect(rope.offsetAt(scalar, unit)).toBe(offset);
    }
    if (value.length === 2) expect(() => rope.scalarAt(utf16 + 1, "utf16")).toThrow("INVALID_BOUNDARY");
    const bytes = encodeURIComponent(value).replace(/%[0-9a-f]{2}/gi, "x").length;
    for (let i = 1; i < bytes; i++) expect(() => rope.scalarAt(utf8 + i, "utf8")).toThrow("INVALID_BOUNDARY");
    utf16 += value.length; utf8 += bytes; scalar++;
  }
  for (const unit of ["utf16", "utf8", "scalar"] as const) {
    expect(rope.scalarAt(rope.length(unit), unit)).toBe(scalar);
    expect(() => rope.scalarAt(-1, unit)).toThrow("INVALID_RANGE");
  }
  expect(() => rope.length("line" as TextUnit)).toThrow("INVALID_REFERENCE");
  expect(() => TextRope.from("\ud800")).toThrow("INVALID_UNICODE");
});

test("rope replacement shares distant B+ nodes, preserves snapshots and compacts edit seams", () => {
  const original = TextRope.from("A".repeat(CHUNK_MAX * 1024));
  const changed = original.replace(CHUNK_MAX * 512, CHUNK_MAX * 512 + 1, "😀");
  const oldNodes = nodeSet(original.debugRoot());
  const newNodes = nodeSet(changed.debugRoot());
  const shared = [...newNodes].filter((node) => oldNodes.has(node)).length;
  expect(shared > oldNodes.size * 0.8).toBe(true);
  expect(newNodes.size - shared < 100).toBe(true);
  expect(original.summary.utf16).toBe(CHUNK_MAX * 1024);
  expect(changed.summary.utf16).toBe(CHUNK_MAX * 1024 + 1);
  expect(changed.slice(CHUNK_MAX * 512 - 1, CHUNK_MAX * 512 + 3).toString()).toBe("A😀A");
  expect(original.replace(0, 1, "A")).toBe(original);
  let small = TextRope.from("abc");
  for (let i = 0; i < 500; i++) small = small.replace(1, 1, "x").replace(1, 2, "");
  check(small, "abc");
  expect([...small.chunks()].length).toBe(1);
});

test("seeded rope splices match a flat Unicode oracle while old versions remain unchanged", () => {
  const raw = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.SEED ?? "424242";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > 0xffffffff) {
    throw new Error("SEED must be a uint32 decimal integer");
  }
  let state = Number(raw) >>> 0;
  const next = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % limit; };
  let text = "A😀\r\n中".repeat(600);
  let rope = TextRope.from(text);
  const history: { rope: TextRope; text: string }[] = [];
  const edits: unknown[] = [];
  try {
    for (let i = 0; i < 400; i++) {
      const offsets = [0];
      for (const scalar of text) offsets.push(offsets[offsets.length - 1]! + scalar.length);
      const start = next(offsets.length);
      const end = start + next(Math.min(12, offsets.length - start));
      const inserted = ["", "😀", "\r", "\n", "\r\n", "e\u0301", "xyz"][next(7)]!;
      edits.push({ start: offsets[start], end: offsets[end], inserted });
      if (i % 20 === 0) history.push({ rope, text });
      rope = rope.replace(offsets[start]!, offsets[end]!, inserted);
      text = text.slice(0, offsets[start]) + inserted + text.slice(offsets[end]);
      check(rope, text);
    }
    for (const previous of history) check(previous.rope, previous.text);
  } catch (cause) {
    throw new Error(JSON.stringify({ seed: raw, edits }, null, 2), { cause });
  }
});
