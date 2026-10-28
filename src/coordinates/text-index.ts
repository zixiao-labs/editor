import type { TextUnit } from "../contracts/core.js";
import { EditorError } from "../errors.js";

/** Validate one Unicode scalar and return its exact UTF-8 width. */
export function scalarUtf8Length(scalar: string): number {
  const code = typeof scalar === "string" ? scalar.codePointAt(0) : undefined;
  if (code === undefined || (code >= 0xd800 && code <= 0xdfff) ||
    scalar.length !== (code > 0xffff ? 2 : 1)) {
    throw new EditorError("INVALID_UNICODE", "INVALID_UNICODE: expected one Unicode scalar");
  }
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

function checkOffset(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new EditorError("INVALID_RANGE", "INVALID_RANGE: offset must be an integer within the source");
  }
}

/**
 * An immutable boundary index, not a grapheme or line/column index.
 * Construction is O(scalars); exact UTF-8/UTF-16 lookup is O(log scalars).
 * Prefix arrays are private: freezing a public Map/typed-array shell would not
 * make its contents immutable. No DOM, TextEncoder or platform encoding API.
 */
export class TextIndex {
  readonly text: string;
  readonly #utf16: readonly number[];
  readonly #utf8: readonly number[];

  constructor(text: string) {
    if (typeof text !== "string") {
      throw new EditorError("INVALID_UNICODE", "INVALID_UNICODE: source text must be a string");
    }
    const utf16 = [0];
    const utf8 = [0];
    let units = 0;
    let bytes = 0;
    for (const scalar of text) {
      bytes += scalarUtf8Length(scalar);
      units += scalar.length;
      utf16.push(units);
      utf8.push(bytes);
    }
    this.text = text;
    this.#utf16 = Object.freeze(utf16);
    this.#utf8 = Object.freeze(utf8);
    Object.freeze(this);
  }

  length(unit: TextUnit): number {
    switch (unit) {
      case "utf16": return this.#utf16[this.#utf16.length - 1]!;
      case "utf8": return this.#utf8[this.#utf8.length - 1]!;
      case "scalar": return this.#utf16.length - 1;
      default: throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown text unit");
    }
  }

  scalarAt(offset: number, unit: TextUnit): number {
    checkOffset(offset, this.length(unit));
    if (unit === "scalar") return offset;
    const boundaries = unit === "utf16" ? this.#utf16 : this.#utf8;
    let low = 0;
    let high = boundaries.length - 1;
    while (low <= high) {
      const mid = low + Math.floor((high - low) / 2);
      const boundary = boundaries[mid]!;
      if (boundary === offset) return mid;
      if (boundary < offset) low = mid + 1;
      else high = mid - 1;
    }
    throw new EditorError("INVALID_BOUNDARY", "INVALID_BOUNDARY: offset splits a Unicode scalar");
  }

  offsetAt(scalar: number, unit: TextUnit): number {
    this.length(unit); // Validate the unit even for empty text / scalar zero.
    checkOffset(scalar, this.length("scalar"));
    if (unit === "scalar") return scalar;
    return (unit === "utf16" ? this.#utf16 : this.#utf8)[scalar]!;
  }

  convert(offset: number, from: TextUnit, to: TextUnit): number {
    // Identity conversion still validates the boundary.
    return this.offsetAt(this.scalarAt(offset, from), to);
  }
}
