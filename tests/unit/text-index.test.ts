import { expect, test } from "@lightning-js/lightning";
import { TextIndex } from "../../src/coordinates/text-index.js";
import type { TextUnit } from "../../src/contracts/core.js";

const units: readonly TextUnit[] = ["utf16", "utf8", "scalar"];

test("source coordinate index uses exact scalar boundaries in all three units", () => {
  const text = "A😀e\u0301\r\n中";
  const index = new TextIndex(text);
  const offsets = {
    utf16: [0, 1, 3, 4, 5, 6, 7, 8],
    utf8: [0, 1, 5, 6, 8, 9, 10, 13],
    scalar: [0, 1, 2, 3, 4, 5, 6, 7],
  };
  expect(index.text).toBe(text);
  for (const unit of units) {
    expect(index.length(unit)).toBe(offsets[unit][7]);
    for (let scalar = 0; scalar <= 7; scalar++) {
      expect(index.offsetAt(scalar, unit)).toBe(offsets[unit][scalar]);
      expect(index.scalarAt(offsets[unit][scalar]!, unit)).toBe(scalar);
      for (const target of units) {
        expect(index.convert(offsets[unit][scalar]!, unit, target)).toBe(offsets[target][scalar]);
      }
    }
  }
  // Combining marks and the interior of CRLF remain legal low-level boundaries.
  expect(index.convert(4, "utf16", "scalar")).toBe(3);
  expect(index.convert(6, "utf16", "scalar")).toBe(5);
});

test("invalid offsets, units, surrogate interiors and UTF-8 interiors never clamp", () => {
  const index = new TextIndex("😀中");
  for (const unit of units) {
    for (const offset of [-1, NaN, Infinity, -Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => index.scalarAt(offset, unit)).toThrow("INVALID_RANGE");
      expect(() => index.convert(offset, unit, unit)).toThrow("INVALID_RANGE");
    }
    expect(() => index.scalarAt(index.length(unit) + 1, unit)).toThrow("INVALID_RANGE");
    expect(() => index.offsetAt(3, unit)).toThrow("INVALID_RANGE");
  }
  expect(() => index.scalarAt(1, "utf16")).toThrow("INVALID_BOUNDARY");
  for (const offset of [1, 2, 3, 5, 6]) {
    expect(() => index.scalarAt(offset, "utf8")).toThrow("INVALID_BOUNDARY");
  }
  expect(() => index.length("line" as TextUnit)).toThrow("INVALID_REFERENCE");
  expect(() => index.scalarAt(0, "line" as TextUnit)).toThrow("INVALID_REFERENCE");
  expect(() => index.offsetAt(0, "line" as TextUnit)).toThrow("INVALID_REFERENCE");
});

test("Unicode validation rejects unpaired surrogates without normalizing text", () => {
  for (const text of ["\ud800", "\udfff", "\ud800A", "A\udfff", "\ud800\ud800\udc00"]) {
    expect(() => new TextIndex(text)).toThrow("INVALID_UNICODE");
  }
  for (const text of ["", "\0", "\r", "\n", "\r\n", "e\u0301", "é", "\ud800\udc00", "\udbff\udfff"]) {
    expect(new TextIndex(text).text).toBe(text);
  }
  expect(() => new TextIndex(null as unknown as string)).toThrow("INVALID_UNICODE");
});

test("all indexed boundaries agree with independently encoded Unicode prefixes", () => {
  // encodeURIComponent uses a different UTF-8 implementation from the production
  // width calculation. Exhaust every UTF-16/UTF-8 offset, including invalid ones.
  const alphabet = ["\0", "\u007f", "\u0080", "\u07ff", "\u0800", "\uffff",
    "\u{10000}", "\u{10ffff}", "😀", "中", "e", "\u0301", "\r", "\n"];
  let state = 0x8734a1;
  for (let run = 0; run < 100; run++) {
    let text = "";
    for (let i = 0; i < run % 24; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      text += alphabet[state % alphabet.length];
    }
    const scalars = Array.from(text);
    const prefixes = scalars.map((_, i) => scalars.slice(0, i).join(""));
    prefixes.push(text);
    const utf16 = prefixes.map((prefix) => prefix.length);
    const utf8 = prefixes.map((prefix) => encodeURIComponent(prefix).replace(/%[0-9a-f]{2}/gi, "x").length);
    const index = new TextIndex(text);
    for (const [unit, boundaries] of [["utf16", utf16], ["utf8", utf8]] as const) {
      for (let offset = 0; offset <= boundaries[boundaries.length - 1]!; offset++) {
        const scalar = boundaries.indexOf(offset);
        if (scalar < 0) {
          expect(() => index.scalarAt(offset, unit)).toThrow("INVALID_BOUNDARY");
        } else {
          expect(index.scalarAt(offset, unit)).toBe(scalar);
          expect(index.offsetAt(scalar, unit)).toBe(offset);
        }
      }
    }
  }
});
