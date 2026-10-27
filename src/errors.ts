export type JsonValue = null | boolean | number | string |
  readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type EditorErrorCode =
  | "UNKNOWN_DOCUMENT" | "DOCUMENT_NOT_IN_HEAD" | "BASE_MISMATCH" | "UNKNOWN_REVISION"
  | "HISTORY_UNAVAILABLE" | "IDENTITY_CONFLICT" | "INVALID_CAUSAL_GRAPH" | "MISSING_DEPENDENCIES"
  | "INVALID_REFERENCE" | "UNSUPPORTED_FORMAT" | "LIMIT_EXCEEDED" | "STALE_CHECKPOINT"
  | "WRONG_REVISION" | "INVALID_RANGE" | "INVALID_BOUNDARY" | "INVALID_UNICODE"
  | "DIFFERENT_ATOMIC_DOMAIN" | "INCOMPLETE_TRANSACTION_GROUP" | "INVALID_SELECTION_SET"
  | "NO_SELECTION" | "UNRESOLVED_SELECTION" | "OVERLAPPING_EDITS" | "ALIAS_EDIT_CONFLICT"
  | "CROSS_EXCERPT_EDIT" | "DISPOSED" | "RESOURCE_IN_USE" | "REENTRANT_WRITE"
  | "UNSUPPORTED_COMPACTION" | "RANDOM_UNAVAILABLE" | "SYNC_SCOPE_MISMATCH" | "SENDER_MISMATCH"
  | "INVALID_PRESENCE" | "INVALID_DIFF_LABEL" | "URI_IN_USE" | "UNSUPPORTED_CAPABILITY"
  | "UNSYNCHRONIZABLE_REVISION" | "PROTOCOL_ERROR" | "CANCELLED" | "TIMEOUT" | "DISCONNECTED"
  | "FONT_UNAVAILABLE" | "SHAPING_FAILED" | "WEBGPU_UNAVAILABLE" | "DEVICE_LOST"
  | "COMPOSITION_CONFLICT";

function copyJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(copyJson));
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyJson(item)])));
  }
  return value;
}

export class EditorError extends Error {
  readonly code: EditorErrorCode;
  readonly details: Readonly<Record<string, JsonValue>> | undefined;

  constructor(
    code: EditorErrorCode,
    message: string,
    options: { details?: Readonly<Record<string, JsonValue>>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "EditorError";
    this.code = code;
    this.details = options.details === undefined ? undefined :
      copyJson(options.details) as Readonly<Record<string, JsonValue>>;
  }
}
