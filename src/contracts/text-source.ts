import type { Disposable } from "./core.js";
import type { Opaque } from "../identity.js";

/** A render read identity, NOT a causal RevisionId or a StablePosition. */
export type TextReadVersion = Opaque<object, "TextReadVersion">;
export interface TextReadPoint { readonly version: TextReadVersion; readonly offsetUtf16: number }
export interface TextReadRange { readonly version: TextReadVersion; readonly startUtf16: number; readonly endUtf16: number }
export interface TextReadSnapshot extends Disposable {
  readonly version: TextReadVersion;
  readonly lengthUtf16: number;
  assertValid(): void;
  pointUtf16(offset: number): TextReadPoint;
  rangeUtf16(start: number, end: number): TextReadRange;
  read(range: TextReadRange): string;
  readUtf16(start: number, end: number): string;
}
interface TextReadLeaseBase extends Disposable {
  readonly lengthUtf16: number;
  /** Exact bounded UTF-16 reads, including raw boundary probes. No normalization. */
  readUtf16(start: number, end: number): string;
  /** Optional latestness check for persistent snapshots, before invalidation delivery. */
  isCurrent?(): boolean;
}
export type TextReadLease =
  | (TextReadLeaseBase & { readonly kind: "snapshot" })
  | (TextReadLeaseBase & {
    readonly kind: "versioned";
    /** Must detect every mutation, including ABA; valid during the lease. */
    isCurrent(): boolean;
  });
/** Product storage is borrowed. The library never edits or disposes the buffer. */
export interface TextSourceProvider {
  snapshot(): TextReadLease;
  onChange(listener: () => void): Disposable;
}
export interface TextSource extends Disposable {
  snapshot(): TextReadSnapshot;
  /** False for alien, released, stale or superseded reads; useful after async layout. */
  isCurrent(snapshot: TextReadSnapshot): boolean;
  /** Coalesced invalidation, not a history/transaction event stream. */
  onChange(listener: () => void): Disposable;
}
