import type { TextUnit } from "../contracts/core.js";
import { TextRope } from "../text/rope.js";
export { scalarUtf8Length } from "../text/unicode.js";

/**
 * Snapshot coordinate facade over the SAME immutable text rope. No per-document
 * scalar prefix arrays or flattening during construction/conversion. Seek uses
 * B+ summaries, then scans only the bounded target chunk. Text is materialized
 * only when explicitly requested. This is not a grapheme or line/column API.
 */
export class TextIndex {
  readonly #rope: TextRope;

  constructor(text: string | TextRope) {
    this.#rope = text instanceof TextRope ? text : TextRope.from(text);
    Object.freeze(this);
  }

  get text(): string { return this.#rope.toString(); }
  length(unit: TextUnit): number { return this.#rope.length(unit); }
  scalarAt(offset: number, unit: TextUnit): number { return this.#rope.scalarAt(offset, unit); }
  offsetAt(scalar: number, unit: TextUnit): number { return this.#rope.offsetAt(scalar, unit); }
  convert(offset: number, from: TextUnit, to: TextUnit): number {
    return this.offsetAt(this.scalarAt(offset, from), to);
  }
}
