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
