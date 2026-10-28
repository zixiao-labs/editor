import type { TextUnit } from "../contracts/core.js";
import { SumTree, type SumNode, type SummaryOps } from "../collections/sum-tree.js";
import { EditorError } from "../errors.js";
import { scalarUtf8Length } from "./unicode.js";

export const CHUNK_MAX: number = 1024; // UTF-16 units; never split a scalar.
export interface TextSummary {
  readonly utf16: number;
  readonly utf8: number;
  readonly scalars: number;
  readonly lineBreaks: number;
  readonly firstLineUtf16: number;
  readonly lastLineUtf16: number;
  readonly longestLineUtf16: number;
  readonly longestRow: number;
  readonly startsWithLf: boolean;
  readonly endsWithCr: boolean;
}
export interface RopeChunk { readonly text: string; readonly summary: TextSummary }
const EMPTY: TextSummary = Object.freeze({
  utf16: 0, utf8: 0, scalars: 0, lineBreaks: 0, firstLineUtf16: 0, lastLineUtf16: 0,
  longestLineUtf16: 0, longestRow: 0, startsWithLf: false, endsWithCr: false,
});
function summarize(text: string): TextSummary {
  let utf8 = 0; let scalars = 0; let row = 0; let column = 0; let first = 0;
  let longest = 0; let longestRow = 0; let previousCr = false;
  for (const scalar of text) {
    utf8 += scalarUtf8Length(scalar); scalars++;
    if (scalar === "\n" && previousCr) { previousCr = false; continue; }
    previousCr = scalar === "\r";
    if (scalar === "\r" || scalar === "\n") {
      if (!row) first = column;
      if (column > longest) { longest = column; longestRow = row; }
      row++; column = 0;
    } else column += scalar.length;
  }
  if (!row) first = column;
  if (column > longest) { longest = column; longestRow = row; }
  return Object.freeze({
    utf16: text.length, utf8, scalars, lineBreaks: row, firstLineUtf16: first,
    lastLineUtf16: column, longestLineUtf16: longest, longestRow,
    startsWithLf: text.startsWith("\n"), endsWithCr: text.endsWith("\r"),
  });
}
function add(left: TextSummary, right: TextSummary): TextSummary {
  if (!left.utf16) return right;
  if (!right.utf16) return left;
  const joinedCrLf = left.endsWithCr && right.startsWithLf ? 1 : 0;
  const rowOffset = left.lineBreaks - joinedCrLf;
  const crossing = left.lastLineUtf16 + right.firstLineUtf16;
  let longest = left.longestLineUtf16;
  let longestRow = left.longestRow;
  for (const [length, row] of [[crossing, rowOffset], [right.longestLineUtf16, rowOffset + right.longestRow]] as const) {
    if (length > longest || (length === longest && row < longestRow)) { longest = length; longestRow = row; }
  }
  return Object.freeze({
    utf16: left.utf16 + right.utf16, utf8: left.utf8 + right.utf8, scalars: left.scalars + right.scalars,
    lineBreaks: left.lineBreaks + right.lineBreaks - joinedCrLf,
    firstLineUtf16: left.lineBreaks ? left.firstLineUtf16 : left.firstLineUtf16 + right.firstLineUtf16,
    lastLineUtf16: right.lineBreaks ? right.lastLineUtf16 : left.lastLineUtf16 + right.lastLineUtf16,
    longestLineUtf16: longest, longestRow, startsWithLf: left.startsWithLf, endsWithCr: right.endsWithCr,
  });
}
const OPS: SummaryOps<RopeChunk, TextSummary> = Object.freeze({
  empty: EMPTY, measure: (chunk: RopeChunk): TextSummary => chunk.summary, add,
});
const chunk = (text: string): RopeChunk => Object.freeze({ text, summary: summarize(text) });
function metric(unit: TextUnit): (summary: TextSummary) => number {
  switch (unit) {
    case "utf16": return (summary) => summary.utf16;
    case "utf8": return (summary) => summary.utf8;
    case "scalar": return (summary) => summary.scalars;
    default: throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown text unit");
  }
}

/** Immutable chunked rope over a persistent multiway B+ SumTree. */
export class TextRope {
  readonly #tree: SumTree<RopeChunk, TextSummary>;
  private constructor(tree: SumTree<RopeChunk, TextSummary>) { this.#tree = tree; Object.freeze(this); }

  static from(text: string): TextRope { return TextRope.fromChunks([text]); }

  /** Input fragments must each be valid Unicode; they need not be chunk-sized. */
  static fromChunks(fragments: Iterable<string>): TextRope {
    const chunks: RopeChunk[] = [];
    let pending: string[] = [];
    let length = 0;
    for (const fragment of fragments) {
      if (typeof fragment !== "string") throw new EditorError("INVALID_UNICODE", "INVALID_UNICODE: expected text");
      for (const scalar of fragment) {
        scalarUtf8Length(scalar);
        if (length + scalar.length > CHUNK_MAX) {
          chunks.push(chunk(pending.join(""))); pending = []; length = 0;
        }
        pending.push(scalar); length += scalar.length;
      }
    }
    if (length) chunks.push(chunk(pending.join("")));
    return new TextRope(SumTree.from(chunks, OPS));
  }

  get summary(): TextSummary { return this.#tree.summary; }
  debugRoot(): SumNode<RopeChunk, TextSummary> | null { return this.#tree.debugRoot(); }
  length(unit: TextUnit): number { return metric(unit)(this.summary); }
  *chunks(): IterableIterator<string> { for (const chunk of this.#tree) yield chunk.text; }
  *scalars(): IterableIterator<string> { for (const text of this.chunks()) yield* text; }
  toString(): string { return [...this.chunks()].join(""); } // Explicit materialization only.

  scalarAt(offset: number, unit: TextUnit): number {
    const dimension = metric(unit);
    const cursor = this.#tree.cursor(dimension);
    cursor.seek(offset);
    if (!cursor.item) return this.summary.scalars;
    let local = dimension(cursor.before);
    let scalar = cursor.before.scalars;
    for (const value of cursor.item.text) {
      if (local === offset) return scalar;
      local += unit === "scalar" ? 1 : unit === "utf16" ? value.length : scalarUtf8Length(value);
      scalar++;
      if (local > offset) break;
    }
    throw new EditorError("INVALID_BOUNDARY", "INVALID_BOUNDARY: offset splits a Unicode scalar");
  }

  offsetAt(scalar: number, unit: TextUnit): number {
    const dimension = metric(unit);
    const cursor = this.#tree.cursor((summary) => summary.scalars);
    cursor.seek(scalar);
    let result = dimension(cursor.before);
    if (!cursor.item) return result;
    let remaining = scalar - cursor.before.scalars;
    for (const value of cursor.item.text) {
      if (!remaining--) break;
      result += unit === "scalar" ? 1 : unit === "utf16" ? value.length : scalarUtf8Length(value);
    }
    return result;
  }

  concat(other: TextRope): TextRope {
    if (!this.#tree.length) return other;
    if (!other.#tree.length) return this;
    const left = this.#tree.at(this.#tree.length - 1);
    const right = other.#tree.at(0);
    if (left.text.length + right.text.length > CHUNK_MAX) return new TextRope(this.#tree.concat(other.#tree));
    const middle = SumTree.from([chunk(left.text + right.text)], OPS);
    return new TextRope(this.#tree.slice(0, this.#tree.length - 1).concat(middle)
      .concat(other.#tree.slice(1, other.#tree.length)));
  }

  split(offset: number, unit: TextUnit = "utf16"): readonly [TextRope, TextRope] {
    const scalar = this.scalarAt(offset, unit);
    const cursor = this.#tree.cursor((summary) => summary.scalars);
    cursor.seek(scalar);
    if (!cursor.item) return [this, TextRope.from("")];
    const local = this.offsetAt(scalar, "utf16") - cursor.before.utf16;
    const left = new TextRope(this.#tree.slice(0, cursor.index));
    const right = new TextRope(this.#tree.slice(cursor.index + 1, this.#tree.length));
    return [
      left.concat(TextRope.from(cursor.item.text.slice(0, local))),
      TextRope.from(cursor.item.text.slice(local)).concat(right),
    ];
  }

  slice(start: number, end: number, unit: TextUnit = "utf16"): TextRope {
    const low = this.scalarAt(start, unit);
    const high = this.scalarAt(end, unit);
    if (high < low) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: reversed rope slice");
    if (!low && high === this.summary.scalars) return this;
    return this.split(high, "scalar")[0].split(low, "scalar")[1];
  }

  replace(start: number, end: number, inserted: string | TextRope, unit: TextUnit = "utf16"): TextRope {
    const added = typeof inserted === "string" ? TextRope.from(inserted) : inserted;
    const low = this.scalarAt(start, unit);
    const high = this.scalarAt(end, unit);
    if (high < low) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: reversed rope replacement");
    if (this.slice(low, high, "scalar").equals(added)) return this;
    const [before, rest] = this.split(low, "scalar");
    return before.concat(added).concat(rest.split(high - low, "scalar")[1]);
  }

  equals(other: TextRope): boolean {
    if (this.#tree.debugRoot() === other.#tree.debugRoot()) return true;
    if (this.summary.utf16 !== other.summary.utf16) return false;
    const a = this.chunks(); const b = other.chunks();
    let left = a.next(); let right = b.next(); let x = 0; let y = 0;
    while (!left.done && !right.done) {
      const length = Math.min(left.value.length - x, right.value.length - y);
      if (left.value.slice(x, x + length) !== right.value.slice(y, y + length)) return false;
      x += length; y += length;
      if (x === left.value.length) { left = a.next(); x = 0; }
      if (y === right.value.length) { right = b.next(); y = 0; }
    }
    return Boolean(left.done && right.done);
  }
}
