import type { EditingHead } from "./contracts/core.js";
import type { TextReadLease, TextReadRange, TextReadSnapshot, TextReadVersion, TextSource, TextSourceProvider } from "./contracts/text-source.js";
import { EditorError } from "./errors.js";
import type { DocumentId } from "./identity.js";
import { scalarUtf8Length } from "./text/unicode.js";

/** Adapt gap buffers, piece tables or persistent snapshots without importing a history engine. */
export function createTextSource(provider: TextSourceProvider, options: { onError?: (error: EditorError) => void } = {}): TextSource {
  if (!provider || typeof provider.snapshot !== "function" || typeof provider.onChange !== "function") {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: text source provider is incomplete");
  }
  let disposed = false, closing = false, generation = 0n, retained = 0, scheduled = false;
  const listeners = new Set<Readonly<{ call: () => void }>>();
  const onError = options.onError;
  const reads = new WeakMap<TextReadSnapshot, () => boolean>();
  const active = (): void => { if (disposed || closing) throw new EditorError("DISPOSED", "DISPOSED: text source has been released"); };
  const subscription = provider.onChange(() => {
    if (disposed) return;
    generation++;
    if (scheduled) return;
    scheduled = true;
    void Promise.resolve().then(() => {
      scheduled = false;
      if (disposed) return;
      for (const listener of [...listeners]) if (listeners.has(listener)) {
        try { listener.call(); }
        catch (cause) {
          const error = cause instanceof EditorError ? cause : new EditorError("INVALID_REFERENCE", "Text source listener failed", { cause });
          if (onError) {
            try { onError(error); } catch (failure) { void Promise.resolve().then(() => { throw failure; }); }
          } else void Promise.resolve().then(() => { throw error; });
        }
      }
    });
  });
  if (!subscription || typeof subscription.dispose !== "function") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: text subscription needs disposal");
  return Object.freeze({
    snapshot(): TextReadSnapshot {
      active();
      const at = generation, lease = provider.snapshot();
      if (!lease || typeof lease.readUtf16 !== "function" || typeof lease.dispose !== "function" ||
        (lease.kind !== "snapshot" && lease.kind !== "versioned") ||
        (lease.isCurrent !== undefined && typeof lease.isCurrent !== "function") ||
        (lease.kind === "versioned" && typeof lease.isCurrent !== "function")) {
        throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid text read lease");
      }
      const length = lease.lengthUtf16;
      if (!Number.isSafeInteger(length) || length < 0) {
        lease.dispose(); throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: invalid text length");
      }
      let alive = true, releasing = false;
      const current = () => alive && !releasing && !disposed && !closing && at === generation && (lease.isCurrent === undefined || lease.isCurrent() === true);
      const check = (): void => {
        active();
        if (!alive || releasing) throw new EditorError("DISPOSED", "DISPOSED: text read has been released");
        if (lease.kind === "versioned" && !current()) throw new EditorError("STALE_TEXT_VIEW", "STALE_TEXT_VIEW: mutable text changed during a read lease");
      };
      const raw = (start: number, end: number): string => {
        check();
        const value = lease.readUtf16(start, end);
        check();
        if (typeof value !== "string" || value.length !== end - start) {
          throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: provider returned an inexact text range");
        }
        return value;
      };
      const boundary = (offset: number): void => {
        check();
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
          throw new EditorError("INVALID_RANGE", "INVALID_RANGE: text offset outside read lease");
        }
        if (offset && offset < length) {
          const pair = raw(offset - 1, offset + 1);
          const left = pair.charCodeAt(0), right = pair.charCodeAt(1);
          if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) {
            throw new EditorError("INVALID_BOUNDARY", "INVALID_BOUNDARY: text offset splits a Unicode scalar");
          }
        }
      };
      const span = (start: number, end: number): void => {
        boundary(start); boundary(end);
        if (end < start) throw new EditorError("INVALID_RANGE", "INVALID_RANGE: reversed text read");
      };
      const read = (start: number, end: number): string => {
        span(start, end);
        const value = raw(start, end);
        for (const scalar of value) scalarUtf8Length(scalar);
        check(); return value;
      };
      const version = Object.freeze({}) as TextReadVersion;
      const snapshot: TextReadSnapshot = Object.freeze({
        version, lengthUtf16: length, assertValid: check,
        pointUtf16(offset) { boundary(offset); return Object.freeze({ version, offsetUtf16: offset }); },
        rangeUtf16(start, end) { span(start, end); return Object.freeze({ version, startUtf16: start, endUtf16: end }); },
        read(input: TextReadRange) {
          const { version: target, startUtf16, endUtf16 } = input;
          if (target !== version) throw new EditorError("WRONG_TEXT_VIEW", "WRONG_TEXT_VIEW: range belongs to another text read");
          return read(startUtf16, endUtf16);
        },
        readUtf16: read,
        dispose() {
          if (!alive) return;
          if (releasing) throw new EditorError("REENTRANT_WRITE", "REENTRANT_WRITE: recursive text read disposal");
          releasing = true;
          try { lease.dispose(); alive = false; retained--; } finally { releasing = false; }
        },
      } satisfies TextReadSnapshot);
      try { check(); } catch (cause) { lease.dispose(); throw cause; }
      retained++;
      reads.set(snapshot, current);
      return snapshot;
    },
    isCurrent(snapshot: TextReadSnapshot): boolean { active(); return reads.get(snapshot)?.() ?? false; },
    onChange(listener: () => void) {
      active();
      if (typeof listener !== "function") throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: text listener must be a function");
      const subscription = Object.freeze({ call: listener });
      listeners.add(subscription);
      return Object.freeze({ dispose() { listeners.delete(subscription); } });
    },
    dispose() {
      if (disposed) return;
      if (closing) throw new EditorError("REENTRANT_WRITE", "REENTRANT_WRITE: recursive text source disposal");
      if (retained) throw new EditorError("RESOURCE_IN_USE", "RESOURCE_IN_USE: text reads still borrow this source");
      closing = true;
      try { subscription.dispose(); listeners.clear(); disposed = true; } finally { closing = false; }
    },
  });
}

/** Render the same history backend through the read-only port, without copying it into a second buffer. */
export function textSourceFromHead(head: EditingHead, document: DocumentId): TextSource {
  return createTextSource({
    snapshot(): TextReadLease {
      const stamp = head.checkpoint().stamp;
      const snapshot = head.snapshot(document);
      // History ranges are scalar-safe, but the generic reader also needs raw
      // two-code-unit boundary probes. Expand only a split endpoint, then trim
      // the bounded copy; never weaken the history snapshot's range contract.
      const edge = (offset: number, direction: -1 | 1): number => {
        try { snapshot.pointUtf16(offset); return offset; }
        catch (cause) {
          if (cause instanceof EditorError && cause.code === "INVALID_BOUNDARY") return offset + direction;
          throw cause;
        }
      };
      return Object.freeze({
        kind: "snapshot", lengthUtf16: snapshot.lengthUtf16,
        readUtf16(start: number, end: number) {
          const from = edge(start, -1), to = edge(end, 1);
          return snapshot.readUtf16(from, to).slice(start - from, end - from);
        },
        isCurrent() {
          try { return head.checkpoint().stamp === stamp; }
          catch (cause) { if (cause instanceof EditorError && cause.code === "DISPOSED") return false; throw cause; }
        },
        dispose: () => snapshot.dispose(),
      });
    },
    onChange(listener) {
      return head.onChange((event) => {
        if (event.reason === "checkout" || event.change.documents.includes(document)) listener();
      });
    },
  });
}
