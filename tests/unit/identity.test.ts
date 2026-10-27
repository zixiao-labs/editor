import { expect, test } from "@lightning-js/lightning";
import { documentId, externalBaseId, actorId, replicaId, selectionId, excerptId, EditorError } from "../../src/index.js";

test("identity constructors validate without normalizing or interpreting product identity", () => {
  for (const constructor of [documentId, externalBaseId, actorId, replicaId, selectionId, excerptId]) {
    expect(constructor("opaque:中文/e\u0301")).toBe("opaque:中文/e\u0301");
    expect(() => constructor("")).toThrow("INVALID_REFERENCE");
    expect(() => constructor("bad\nid")).toThrow("INVALID_REFERENCE");
    expect(() => constructor("\ud800")).toThrow("INVALID_UNICODE");
    expect(() => constructor("😀".repeat(257))).toThrow("LIMIT_EXCEEDED");
  }
});

test("EditorError preserves code and cause and copies immutable JSON details", () => {
  const details = { missing: ["tx:1"] };
  const cause = new Error("transport");
  const error = new EditorError("MISSING_DEPENDENCIES", "Missing history", { details, cause });
  details.missing.push("tx:2");
  expect(error).toBeInstanceOf(Error);
  expect(error.code).toBe("MISSING_DEPENDENCIES");
  expect(error.message).toBe("Missing history");
  expect(error.cause).toBe(cause);
  expect(error.details).toEqual({ missing: ["tx:1"] });
  expect(Object.isFrozen(error.details)).toBe(true);
  expect(Object.isFrozen(error.details?.missing)).toBe(true);
});
