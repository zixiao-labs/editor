import type {
  Affinity, PositionResolution, StablePosition, StableRange, TextPoint, TextRange, TextSnapshot, TextUnit,
} from "../contracts/core.js";
import { EditorError } from "../errors.js";
import { documentId, revisionId, type DocumentId, type RevisionId } from "../identity.js";
import { scalarUtf8Length, TextIndex } from "../coordinates/text-index.js";

/** Internal materialization boundary; not a persistent or public wire layout. */
export interface SourceElement {
  readonly id: string;
  readonly scalar: string;
  readonly visible: boolean;
}

export interface SourceRevisionInput {
  readonly document: DocumentId;
  /** Canonical root identity, supplied by the history layer. */
  readonly root: string;
  readonly revision: RevisionId;
  /** Full CRDT order, including invisible elements, without START/END. */
  readonly elements: readonly SourceElement[];
}

type Guard = Readonly<{ kind: "start" | "end" }> | Readonly<{ kind: "element"; id: string }>;
interface SourceCut {
  readonly document: DocumentId;
  readonly root: string;
  readonly guard: Guard;
  readonly affinity: Affinity;
}

// Opaque values have no consumer-writable payload. A future validated codec can
// reconstruct cuts through this module; spreading/casting an object cannot.
const cuts = new WeakMap<StablePosition, SourceCut>();

function checkAffinity(affinity: Affinity): void {
  if (affinity !== "before" && affinity !== "after") {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown insertion affinity");
  }
}

/**
 * Immutable coordinate/position view of one materialized source revision.
 *
 * This consumes ALREADY VALIDATED causal materializations. It does not establish
 * that a revision/root digest or a CRDT ordering is correct, accept history, or
 * interpret absent history as a deletion. The future history boundary must
 * reject unknown revisions before calling resolve.
 *
 * Full order is compiled once to private guard -> visible-prefix ranks. This
 * retains tombstones for O(1) resolution without recursive tree traversal or
 * scanning a long run of deleted elements. No mutable input aliases survive.
 */
export class SourceRevision {
  readonly document: DocumentId;
  readonly revision: RevisionId;
  readonly #root: string;
  readonly #index: TextIndex;
  readonly #visible: readonly string[];
  readonly #guards: ReadonlyMap<string, Readonly<{ before: number; visible: boolean }>>;

  constructor(input: SourceRevisionInput) {
    this.document = documentId(input.document);
    this.revision = revisionId(input.revision);
    if (typeof input.root !== "string" || !input.root.length) {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: missing source root identity");
    }
    this.#root = input.root;
    const visible: string[] = [];
    const text: string[] = [];
    const guards = new Map<string, Readonly<{ before: number; visible: boolean }>>();
    for (const element of input.elements) {
      if (typeof element.id !== "string" || !element.id.length || guards.has(element.id) ||
        typeof element.visible !== "boolean") {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid or duplicate source element");
      }
      scalarUtf8Length(element.scalar);
      guards.set(element.id, Object.freeze({ before: visible.length, visible: element.visible }));
      if (element.visible) {
        visible.push(element.id);
        text.push(element.scalar);
      }
    }
    this.#visible = Object.freeze(visible);
    this.#guards = guards; // Private, never mutated after construction or exposed.
    this.#index = new TextIndex(text.join(""));
    Object.freeze(this);
  }

  #point(offset: number, unit: TextUnit): TextPoint {
    return Object.freeze({ document: this.document, revision: this.revision, unit, offset });
  }

  #sourceScalar(point: TextPoint): number {
    if (!point || point.document !== this.document || point.revision !== this.revision) {
      throw new EditorError("WRONG_REVISION", "WRONG_REVISION: point does not belong to this source snapshot");
    }
    return this.#index.scalarAt(point.offset, point.unit);
  }

  #capture(scalar: number, affinity: Affinity): StablePosition {
    checkAffinity(affinity);
    const id = affinity === "before" ? this.#visible[scalar - 1] : this.#visible[scalar];
    const guard: Guard = id === undefined
      ? Object.freeze({ kind: affinity === "before" ? "start" : "end" })
      : Object.freeze({ kind: "element", id });
    const position = Object.freeze({}) as StablePosition;
    cuts.set(position, Object.freeze({ document: this.document, root: this.#root, guard, affinity }));
    return position;
  }

  snapshot(): TextSnapshot {
    let retained: SourceRevision | undefined = this;
    const active = (): SourceRevision => {
      if (!retained) throw new EditorError("DISPOSED", "DISPOSED: source snapshot has been released");
      return retained;
    };
    const point = (offset: number, unit: TextUnit): TextPoint => {
      const source = active();
      source.#index.scalarAt(offset, unit);
      return source.#point(offset, unit);
    };
    const range = (start: number, end: number): TextRange => {
      const source = active();
      source.#index.scalarAt(start, "utf16");
      source.#index.scalarAt(end, "utf16");
      if (end < start) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: source range is reversed");
      return Object.freeze({
        document: source.document, revision: source.revision, unit: "utf16", start, end,
      });
    };
    const snapshot: TextSnapshot = {
      document: this.document,
      revision: this.revision,
      lengthUtf16: this.#index.length("utf16"),
      text: () => active().#index.text,
      pointUtf16: (offset) => point(offset, "utf16"),
      pointUtf8: (offset) => point(offset, "utf8"),
      pointScalar: (offset) => point(offset, "scalar"),
      convertPoint: (input, unit) => {
        const source = active();
        return source.#point(source.#index.offsetAt(source.#sourceScalar(input), unit), unit);
      },
      rangeUtf16: range,
      anchorUtf16: (offset, options) => {
        const source = active();
        return source.#capture(source.#index.scalarAt(offset, "utf16"), options.affinity);
      },
      stableRangeUtf16: (start, end, options): StableRange => {
        range(start, end);
        const source = active();
        return Object.freeze({
          start: source.#capture(source.#index.scalarAt(start, "utf16"), options.startAffinity),
          end: source.#capture(source.#index.scalarAt(end, "utf16"), options.endAffinity),
        });
      },
      dispose: () => { retained = undefined; },
    };
    return Object.freeze(snapshot);
  }

  resolve(position: StablePosition): PositionResolution {
    const cut = cuts.get(position);
    if (!cut || cut.document !== this.document) {
      throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: position is invalid or belongs to another document");
    }
    if (cut.root !== this.#root) {
      throw new EditorError("BASE_MISMATCH", "BASE_MISMATCH: position belongs to another source root");
    }
    if (cut.guard.kind !== "element") {
      const offset = cut.guard.kind === "start" ? 0 : this.#index.length("utf16");
      return Object.freeze({ status: "present", point: this.#point(offset, "utf16") });
    }
    const guard = this.#guards.get(cut.guard.id);
    if (!guard) return Object.freeze({ status: "not-yet-created" });
    if (!guard.visible) {
      return Object.freeze({
        status: "deleted",
        before: this.#capture(guard.before, "before"),
        after: this.#capture(guard.before, "after"),
      });
    }
    const scalar = guard.before + (cut.affinity === "before" ? 1 : 0);
    return Object.freeze({
      status: "present", point: this.#point(this.#index.offsetAt(scalar, "utf16"), "utf16"),
    });
  }

  translate(point: TextPoint, to: SourceRevision, affinity: Affinity): PositionResolution {
    return to.resolve(this.#capture(this.#sourceScalar(point), affinity));
  }
}
