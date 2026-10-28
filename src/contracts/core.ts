// Type contracts only. Factories are not runtime exports until their stages ship.
import type {
  ActorId, CommitId, DocumentId, ExcerptId, ExternalBaseId, HeadId, HeadStamp, HistoryCursor,
  OperationId, Opaque, ProjectionVersion, ReplicaId, RevisionId, SelectionId, SelectionVersion,
  TransactionGroupId, TransactionId, UndoGroupId,
} from "../identity.js";
import type { EditorError, JsonValue } from "../errors.js";
import type { HistoryBackendDescriptor, HistoryUndoProvider } from "./history-backend.js";

export interface Disposable { dispose(): void }
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
export interface RandomSource { fill(bytes: Uint8Array): void }
export interface HistoryStoreOptions {
  readonly random?: RandomSource;
  readonly onError?: (error: EditorError) => void;
}
export interface RevisionEntry { readonly document: DocumentId; readonly revision: RevisionId }
export interface RevisionSet {
  get(document: DocumentId): RevisionId;
  has(document: DocumentId): boolean;
  entries(): Iterable<RevisionEntry>;
}
export interface HeadCheckpoint {
  readonly headId: HeadId;
  readonly stamp: HeadStamp;
  readonly revisions: RevisionSet;
}
export type TextUnit = "utf16" | "utf8" | "scalar";
export type Affinity = "before" | "after";
export interface TextPoint {
  readonly document: DocumentId;
  readonly revision: RevisionId;
  readonly unit: TextUnit;
  readonly offset: number;
}
export interface TextRange {
  readonly document: DocumentId;
  readonly revision: RevisionId;
  readonly unit: TextUnit;
  readonly start: number;
  readonly end: number;
}
export type StablePosition = Opaque<object, "StablePosition">;
export interface StableRange { readonly start: StablePosition; readonly end: StablePosition }
export interface SourceEndpoint {
  readonly document: DocumentId;
  readonly position: StablePosition;
  readonly excerpt?: ExcerptId;
}
export interface TextSnapshot extends Disposable {
  readonly document: DocumentId;
  readonly revision: RevisionId;
  readonly lengthUtf16: number;
  text(): string;
  pointUtf16(offset: number): TextPoint;
  pointUtf8(offset: number): TextPoint;
  pointScalar(offset: number): TextPoint;
  convertPoint(point: TextPoint, unit: TextUnit): TextPoint;
  rangeUtf16(start: number, end: number): TextRange;
  anchorUtf16(offset: number, options: { affinity: Affinity }): StablePosition;
  stableRangeUtf16(start: number, end: number, options: {
    startAffinity: Affinity; endAffinity: Affinity;
  }): StableRange;
}
export type PositionResolution =
  | Readonly<{ status: "present"; point: TextPoint }>
  | Readonly<{ status: "deleted"; before: StablePosition; after: StablePosition }>
  | Readonly<{ status: "not-yet-created" }>;
export interface Writer extends Disposable {
  readonly actor: ActorId;
  readonly replica: ReplicaId;
}
export interface RetentionHandle extends Disposable { readonly revisions: RevisionSet }
export type PositionToken = Opaque<object, "PositionToken">;
export interface ExportedPosition extends Disposable {
  readonly position: StablePosition;
  readonly token: PositionToken;
}
export interface EditOrigin { readonly kind: string; readonly label?: string }
export interface SourceEdit {
  readonly document: DocumentId;
  readonly range: TextRange;
  readonly text: string;
}
export interface CommitReceipt extends Opaque<object, "CommitReceipt"> {
  readonly id: CommitId;
  readonly before: HeadCheckpoint;
  readonly after: HeadCheckpoint;
  readonly documents: readonly DocumentId[];
  readonly transactions: readonly TransactionId[];
  readonly groups: readonly TransactionGroupId[];
  readonly status: "committed" | "no-change";
}
export interface HeadChangeEvent {
  readonly change: CommitReceipt;
  readonly reason: "commit" | "merge" | "checkout" | "undo" | "redo";
  readonly origin: EditOrigin;
}
export interface DocumentTarget {
  readonly head: EditingHead;
  readonly document: DocumentId;
}
export interface EditingHead extends Disposable {
  checkpoint(): HeadCheckpoint;
  snapshot(document: DocumentId): TextSnapshot;
  document(document: DocumentId): DocumentTarget;
  commit(input: {
    expect: HeadCheckpoint; edits: readonly SourceEdit[]; origin: EditOrigin; attribution?: JsonValue;
  }): CommitReceipt;
  merge(input: { expect: HeadCheckpoint; source: RevisionSet }): CommitReceipt;
  checkout(input: { expect: HeadCheckpoint; at: RevisionSet }): CommitReceipt;
  onChange(listener: (event: HeadChangeEvent) => void): Disposable;
}
export interface RevisionInfo extends RevisionEntry {
  readonly parents: readonly RevisionId[];
  readonly frontier: readonly TransactionId[];
  readonly base: ExternalBaseId;
}
export interface TransactionInfo {
  readonly id: TransactionId;
  readonly document: DocumentId;
  readonly group: TransactionGroupId;
  readonly dependencies: readonly TransactionId[];
  readonly operations: readonly OperationId[];
  readonly actor: ActorId;
  readonly origin: EditOrigin;
  readonly attribution?: JsonValue;
  readonly before: RevisionId;
  readonly after: RevisionId;
}
export interface HistoryPage {
  readonly items: readonly TransactionInfo[];
  readonly next: HistoryCursor | null;
}
export interface ProvenanceSpan {
  readonly range: TextRange;
  readonly transaction: TransactionId | null;
  readonly actor: ActorId | null;
  readonly attribution?: JsonValue;
}
export interface HistoryQueries {
  revision(input: RevisionEntry): RevisionInfo;
  transaction(id: TransactionId): TransactionInfo;
  transactions(input: {
    document: DocumentId; includedIn: RevisionId; limit: number; cursor?: HistoryCursor;
  }): HistoryPage;
  compare(input: {
    document: DocumentId; left: RevisionId; right: RevisionId;
  }): "equal" | "ancestor" | "descendant" | "concurrent";
  provenance(input: {
    document: DocumentId; revision: RevisionId; range: TextRange;
  }): readonly ProvenanceSpan[];
  resolve(input: { position: StablePosition; at: RevisionEntry }): PositionResolution;
  translate(input: { point: TextPoint; to: RevisionId; affinity: Affinity }): PositionResolution;
}
// Opaque payload: no per-character layout is part of this contract.
export type HistoryBundle = Opaque<object, "HistoryBundle">;
export type HistoryImportReport =
  | Readonly<{ status: "accepted" | "duplicate"; availableRevisions: RevisionSet }>
  | Readonly<{ status: "pending"; missing: readonly TransactionId[] }>;
export interface HistoryStore extends Disposable {
  readonly backend: HistoryBackendDescriptor;
  readonly undo?: HistoryUndoProvider;
  createDocument(input: { id: DocumentId; base: { id: ExternalBaseId; text: string } }): RevisionEntry;
  openWriter(input: { actor: ActorId; replica: ReplicaId }): Writer;
  revisions(entries: readonly RevisionEntry[]): RevisionSet;
  fork(input: { at: RevisionSet; writer: Writer }): EditingHead;
  snapshot(input: RevisionEntry): TextSnapshot;
  pin(input: { revisions: RevisionSet }): RetentionHandle;
  exportPosition(input: { position: StablePosition }): ExportedPosition;
  importPosition(token: PositionToken): ExportedPosition;
  exportHistory(input: { target: RevisionSet; known: RevisionSet }): HistoryBundle;
  importHistory(bundle: HistoryBundle, options?: { missing?: "reject" | "defer" }): HistoryImportReport;
  readonly history: HistoryQueries;
  diff(input: DiffInput & DiffOptions): Promise<DiffReport>;
}
export interface Selection {
  readonly id: SelectionId;
  readonly anchor: SourceEndpoint;
  readonly head: SourceEndpoint;
  readonly metadata?: JsonValue;
}
export interface SelectionSnapshot {
  readonly version: SelectionVersion;
  readonly items: readonly Selection[];
  readonly primary: SelectionId | null;
}
export type SavedSelections = Opaque<object, "SavedSelections">;
export interface SelectionRepair {
  readonly selection: SelectionId;
  readonly endpoint: "anchor" | "head";
  readonly reason: "deleted" | "not-yet-created" | "missing-excerpt";
  readonly replacement?: SourceEndpoint;
}
export interface SelectionRestoreResult {
  readonly selections: SelectionSnapshot;
  readonly repairs: readonly SelectionRepair[];
}
export interface SessionCheckpoint {
  readonly source: HeadCheckpoint;
  readonly selections: SelectionVersion;
  readonly projection: ProjectionVersion | null;
}
export interface SelectionChangeEvent {
  readonly before: SelectionSnapshot;
  readonly after: SelectionSnapshot;
  readonly beforeCheckpoint: SessionCheckpoint;
  readonly afterCheckpoint: SessionCheckpoint;
  readonly origin: EditOrigin;
  readonly reason: "set" | "edit" | "merge" | "checkout" | "undo" | "redo" | "projection" | "restore";
  readonly repairs: readonly SelectionRepair[];
}
export interface SelectionController {
  read(): SelectionSnapshot;
  set(input: {
    expect: SelectionVersion; items: readonly Selection[]; primary: SelectionId | null; origin: EditOrigin;
  }): SelectionSnapshot;
  add(input: {
    expect: SelectionVersion; selection: Selection; makePrimary?: boolean; origin: EditOrigin;
  }): SelectionSnapshot;
  update(input: {
    expect: SelectionVersion; selection: Selection; origin: EditOrigin;
  }): SelectionSnapshot;
  remove(input: {
    expect: SelectionVersion; id: SelectionId; primary?: SelectionId | null; origin: EditOrigin;
  }): SelectionSnapshot;
  setPrimary(input: { expect: SelectionVersion; id: SelectionId; origin: EditOrigin }): SelectionSnapshot;
  save(): SavedSelections;
  restore(input: {
    expect: SelectionVersion; saved: SavedSelections; missing?: "reject" | "repair"; origin: EditOrigin;
  }): SelectionRestoreResult;
  onChange(listener: (event: SelectionChangeEvent) => void): Disposable;
}
export type Replacement =
  | { readonly kind: "uniform"; readonly text: string }
  | { readonly kind: "per-selection"; readonly values: ReadonlyMap<SelectionId, string> };
export interface SessionCommitReceipt extends CommitReceipt {
  readonly selectionEffects: SelectionRestoreResult;
}
export interface UndoGroupHandle { readonly id: UndoGroupId; close(): void }
export type UndoResult =
  | Readonly<{ status: "applied" | "partial" | "no-effect"; change: SessionCommitReceipt }>
  | Readonly<{ status: "empty" }>;
export interface UndoController {
  beginGroup(): UndoGroupHandle;
  undo(input: { expect: SessionCheckpoint }): UndoResult;
  redo(input: { expect: SessionCheckpoint }): UndoResult;
}
export interface EditorSession extends Disposable {
  readonly selections: SelectionController;
  readonly undo: UndoController;
  checkpoint(): SessionCheckpoint;
  allocateSelectionId(): SelectionId;
  replaceSelections(input: {
    expect: SessionCheckpoint; replacement: Replacement; origin: EditOrigin;
    attribution?: JsonValue; undoGroup?: UndoGroupId;
  }): SessionCommitReceipt;
}
export interface ExcerptSpec {
  readonly id: ExcerptId;
  readonly document: DocumentId;
  readonly range: StableRange;
}
export interface ProjectionDecoration {
  readonly id: string;
  readonly before: ExcerptId;
  readonly text: string;
}
export interface ProjectionPoint {
  readonly version: ProjectionVersion;
  readonly excerpt: ExcerptId;
  readonly unit: "utf16";
  readonly offset: number;
}
export interface ProjectionBoundary {
  readonly version: ProjectionVersion;
  readonly left: ExcerptId | null;
  readonly right: ExcerptId | null;
}
export interface NonSourceProjectionPoint {
  readonly kind: "decoration" | "boundary";
  readonly boundary: ProjectionBoundary;
}
export interface ProjectionOccurrence {
  readonly point: ProjectionPoint;
  readonly source: SourceEndpoint;
}
export interface ProjectionSnapshot extends Disposable {
  readonly version: ProjectionVersion;
  toSource(point: ProjectionPoint): SourceEndpoint | NonSourceProjectionPoint;
  fromSource(input: { document: DocumentId; position: StablePosition }): readonly ProjectionOccurrence[];
  resolveBoundary(input: { boundary: ProjectionBoundary; side: "left" | "right" }): SourceEndpoint;
}
export interface MultiBuffer extends Disposable {
  snapshot(): ProjectionSnapshot;
  setExcerpts(input: { expect: ProjectionVersion; excerpts: readonly ExcerptSpec[] }): ProjectionSnapshot;
}
export type DiffInput =
  | { readonly change: CommitReceipt; readonly from?: never; readonly to?: never }
  | { readonly from: RevisionSet; readonly to: RevisionSet; readonly change?: never };
export interface DiffOptions {
  readonly contextLines?: number;
  readonly intraline?: "grapheme" | "none";
  readonly maxOutputBytes?: number;
  readonly signal?: CancellationSignal;
}
export interface UnifiedDiffOptions {
  readonly labels?: ReadonlyMap<DocumentId, Readonly<{ before: string; after: string }>>;
}
export interface DiffReplacement {
  readonly before: TextRange | null;
  readonly after: TextRange | null;
  readonly deleted: string;
  readonly inserted: string;
  readonly intraline: readonly Readonly<{ before: TextRange | null; after: TextRange | null }>[];
}
export interface DiffLine {
  readonly kind: "context" | "insert" | "delete";
  readonly text: string;
  readonly hasFinalLf: boolean;
  readonly beforeLine: number | null;
  readonly afterLine: number | null;
}
export interface DiffHunk {
  readonly beforeStart: number;
  readonly beforeCount: number;
  readonly afterStart: number;
  readonly afterCount: number;
  readonly lines: readonly DiffLine[];
}
export interface DocumentDiff {
  readonly document: DocumentId;
  readonly before: RevisionId | null;
  readonly after: RevisionId | null;
  readonly kind: "modified" | "added" | "removed";
  readonly beforeText: string;
  readonly afterText: string;
  readonly replacements: readonly DiffReplacement[];
  readonly hunks: readonly DiffHunk[];
}
export interface DiffReport {
  readonly schemaVersion: 1;
  readonly basis: "versions" | "commit";
  readonly from: RevisionSet;
  readonly to: RevisionSet;
  readonly transactions: readonly TransactionInfo[];
  readonly documents: readonly DocumentDiff[];
  readonly maxOutputBytes: number;
}
export interface CoreFactories {
  createHistoryStore(options?: HistoryStoreOptions): HistoryStore;
  createEditorSession(input: {
    target: DocumentTarget | MultiBuffer; insertLineEnding?: "\n" | "\r\n";
  }): EditorSession;
  createMultiBuffer(input: {
    head: EditingHead; excerpts: readonly ExcerptSpec[]; decorations?: readonly ProjectionDecoration[];
  }): MultiBuffer;
  formatUnifiedDiff(report: DiffReport, options?: UnifiedDiffOptions): string;
}
