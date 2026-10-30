import { EditorError } from "../errors.js";

export function utf8Length(text: string): number {
  let bytes = 0;
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function invalid(message: string): never {
  throw new EditorError("INVALID_REFERENCE", `INVALID_REFERENCE: ${message}`);
}

/** Strict UTF-8 decoding without platform text decoders; rejects overlong, surrogate and truncated input. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  const scalars: string[] = [];
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index]!;
    let code: number;
    let extra: number;
    let minimum: number;
    if (first < 0x80) { code = first; extra = 0; minimum = 0; }
    else if ((first & 0xe0) === 0xc0) { code = first & 0x1f; extra = 1; minimum = 0x80; }
    else if ((first & 0xf0) === 0xe0) { code = first & 0x0f; extra = 2; minimum = 0x800; }
    else if ((first & 0xf8) === 0xf0) { code = first & 0x07; extra = 3; minimum = 0x10000; }
    else invalid("malformed UTF-8 lead byte");
    if (index + extra >= bytes.length) invalid("truncated UTF-8 sequence");
    for (let offset = 1; offset <= extra; offset++) {
      const next = bytes[index + offset]!;
      if ((next & 0xc0) !== 0x80) invalid("malformed UTF-8 continuation byte");
      code = (code << 6) | (next & 0x3f);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      invalid("non-canonical UTF-8 scalar");
    }
    scalars.push(String.fromCodePoint(code));
    index += extra + 1;
  }
  return scalars.join("");
}
