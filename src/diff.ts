import type {
  CancellationSignal, DiffHunk, DiffLine, DiffOptions, DiffReplacement, DiffReport, TextRange, UnifiedDiffOptions,
} from "./contracts/core.js";
import { EditorError } from "./errors.js";
import type { DocumentId, RevisionId } from "./identity.js";
import { utf8Length } from "./history/bytes.js";

/** Patch lines split on LF only: CR stays in the content, CR-only text is one line. */
export interface PatchLine { readonly text: string; readonly hasFinalLf: boolean }
export function splitPatchLines(text: string): PatchLine[] {
  if (!text) return [];
  const parts = text.split("\n");
  const lines: PatchLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (last && parts[i] === "") break;
    lines.push(Object.freeze({ text: parts[i]!, hasFinalLf: !last }));
  }
  return lines;
}
const joinPatchLines = (lines: readonly PatchLine[]): string =>
  lines.map((line) => line.text + (line.hasFinalLf ? "\n" : "")).join("");
const lineEquals = (a: PatchLine, b: PatchLine): boolean => a.text === b.text && a.hasFinalLf === b.hasFinalLf;

interface SegmenterLike { segment(text: string): Iterable<{ segment: string }> }
let segmenter: SegmenterLike | undefined;
/** Extended grapheme clusters via the platform segmenter; documented ICU dependency. */
export function graphemesOf(text: string): string[] {
  segmenter ??= new Intl.Segmenter("en", { granularity: "grapheme" });
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

type Cancelled = () => void;
function cancellation(signal?: CancellationSignal): Cancelled {
  return () => {
    if (signal !== undefined && signal.aborted) {
      throw new EditorError("CANCELLED", "CANCELLED: diff computation was cancelled");
    }
  };
}

interface Opcode { readonly kind: "equal" | "delete" | "insert"; readonly aStart: number; readonly aEnd: number; readonly bStart: number; readonly bEnd: number }

const MAX_MYERS_STEPS = 65_536;
const MAX_MYERS_SIZE = 100_000;
const MYERS_MEMORY_BYTES = 64 * 1024 * 1024;

/**
 * Deterministic edit script between two sequences: common prefix/suffix trim,
 * then Myers O((N+M)D) with a bounded trace. Regions that would exceed the
 * step/memory budget fall back to one coarse delete+insert block; the result is
 * always exact and reconstructable, only less refined for extreme inputs.
 */
function diffSequence<T>(
  a: readonly T[], b: readonly T[], equals: (x: T, y: T) => boolean, cancelled: Cancelled,
): Opcode[] {
  const limit = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < limit && equals(a[prefix]!, b[prefix]!)) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix && equals(a[a.length - 1 - suffix]!, b[b.length - 1 - suffix]!)) suffix++;
  const n = a.length - prefix - suffix;
  const m = b.length - prefix - suffix;
  const ops: Opcode[] = prefix
    ? [{ kind: "equal", aStart: 0, aEnd: prefix, bStart: 0, bEnd: prefix }]
    : [];
  if (n === 0 || m === 0) {
    if (n) ops.push({ kind: "delete", aStart: prefix, aEnd: prefix + n, bStart: prefix, bEnd: prefix });
    if (m) ops.push({ kind: "insert", aStart: a.length - suffix, aEnd: a.length - suffix, bStart: prefix, bEnd: prefix + m });
  } else {
    ops.push(...myers(a, b, prefix, n, m, equals, cancelled));
  }
  if (suffix) ops.push({ kind: "equal", aStart: a.length - suffix, aEnd: a.length, bStart: b.length - suffix, bEnd: b.length });
  return ops;
}

function myers<T>(
  a: readonly T[], b: readonly T[], a0: number, n: number, m: number,
  equals: (x: T, y: T) => boolean, cancelled: Cancelled,
): Opcode[] {
  const coarse = (): Opcode[] => [
    { kind: "delete", aStart: a0, aEnd: a0 + n, bStart: a0, bEnd: a0 },
    { kind: "insert", aStart: a0 + n, aEnd: a0 + n, bStart: a0, bEnd: a0 + m },
  ];
  const max = n + m;
  const span = 2 * max + 1;
  const memoryLimit = Math.floor(MYERS_MEMORY_BYTES / (span * 4)) - 1;
  const stepLimit = Math.min(MAX_MYERS_STEPS, memoryLimit);
  if (max > MAX_MYERS_SIZE || stepLimit < 1) return coarse();
  const offset = max;
  const v = new Int32Array(span);
  const trace: Int32Array[] = [];
  let solution = -1;
  outer: for (let d = 0; d <= max; d++) {
    if (d > stepLimit) return coarse();
    cancelled();
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && equals(a[a0 + x]!, b[a0 + y]!)) {
        x++; y++;
        if ((x & 4095) === 0) cancelled();
      }
      v[offset + k] = x;
      if (x >= n && y >= m) { solution = d; break outer; }
    }
  }
  if (solution < 0) return coarse();
  const reversed: Opcode[] = [];
  let x = n;
  let y = m;
  for (let d = solution; d >= 0; d--) {
    const snapshot = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && snapshot[offset + k - 1]! < snapshot[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = snapshot[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x--; y--; }
    if (d > 0) {
      if (x === prevX) reversed.push({ kind: "insert", aStart: a0 + x, aEnd: a0 + x, bStart: a0 + prevY, bEnd: a0 + y });
      else reversed.push({ kind: "delete", aStart: a0 + prevX, aEnd: a0 + x, bStart: a0 + y, bEnd: a0 + y });
    }
    x = prevX;
    y = prevY;
  }
  reversed.reverse();
  const merged: Opcode[] = [];
  for (const op of reversed) {
    const last = merged[merged.length - 1];
    if (last && last.kind === op.kind && last.aEnd === op.aStart && last.bEnd === op.bStart) {
      merged[merged.length - 1] = { kind: op.kind, aStart: last.aStart, aEnd: op.aEnd, bStart: last.bStart, bEnd: op.bEnd };
    } else merged.push(op);
  }
  return merged;
}

interface Block { readonly aStart: number; readonly aEnd: number; readonly bStart: number; readonly bEnd: number }
/**
 * Maximal contiguous changed runs. Myers emits no opcodes for equal runs, so a
 * block also ends when the next opcode is not adjacent to the previous one.
 */
function blocksOf(ops: readonly Opcode[]): Block[] {
  const blocks: Block[] = [];
  let current: { aStart: number; aEnd: number; bStart: number; bEnd: number } | null = null;
  for (const op of ops) {
    if (op.kind === "equal") { current = null; continue; }
    if (current !== null && op.aStart === current.aEnd && op.bStart === current.bEnd) {
      current.aEnd = op.aEnd;
      current.bEnd = op.bEnd;
    } else {
      current = { aStart: op.aStart, aEnd: op.aEnd, bStart: op.bStart, bEnd: op.bEnd };
      blocks.push(current);
    }
  }
  return blocks;
}

function lineOffsets(lines: readonly PatchLine[]): number[] {
  const offsets = [0];
  for (const line of lines) offsets.push(offsets[offsets.length - 1]! + line.text.length + (line.hasFinalLf ? 1 : 0));
  return offsets;
}

function buildHunks(
  beforeLines: readonly PatchLine[], afterLines: readonly PatchLine[], ops: readonly Opcode[], contextLines: number,
): DiffHunk[] {
  const blocks = blocksOf(ops);
  const hunks: DiffHunk[] = [];
  let index = 0;
  while (index < blocks.length) {
    const first = blocks[index]!;
    let last = first;
    let next = index + 1;
    while (next < blocks.length && blocks[next]!.aStart - last.aEnd <= contextLines * 2) {
      last = blocks[next]!;
      next++;
    }
    const covered = blocks.slice(index, next);
    index = next;
    const startA = Math.max(0, first.aStart - contextLines);
    const lead = first.aStart - startA;
    const startB = first.bStart - lead;
    const endA = Math.min(beforeLines.length, last.aEnd + contextLines);
    const endB = last.bEnd + (endA - last.aEnd);
    const lines: DiffLine[] = [];
    let cursorA = startA;
    let cursorB = startB;
    for (const block of covered) {
      while (cursorA < block.aStart) {
        const line = beforeLines[cursorA]!;
        lines.push(Object.freeze({
          kind: "context", text: line.text, hasFinalLf: line.hasFinalLf,
          beforeLine: cursorA + 1, afterLine: cursorB + 1,
        }));
        cursorA++; cursorB++;
      }
      for (let i = block.aStart; i < block.aEnd; i++) {
        const line = beforeLines[i]!;
        lines.push(Object.freeze({ kind: "delete", text: line.text, hasFinalLf: line.hasFinalLf, beforeLine: i + 1, afterLine: null }));
      }
      for (let i = block.bStart; i < block.bEnd; i++) {
        const line = afterLines[i]!;
        lines.push(Object.freeze({ kind: "insert", text: line.text, hasFinalLf: line.hasFinalLf, beforeLine: null, afterLine: i + 1 }));
      }
      cursorA = block.aEnd;
      cursorB = block.bEnd;
    }
    while (cursorA < endA) {
      const line = beforeLines[cursorA]!;
      lines.push(Object.freeze({
        kind: "context", text: line.text, hasFinalLf: line.hasFinalLf,
        beforeLine: cursorA + 1, afterLine: cursorB + 1,
      }));
      cursorA++; cursorB++;
    }
    const beforeCount = endA - startA;
    const afterCount = endB - startB;
    hunks.push(Object.freeze({
      beforeStart: beforeCount === 0 ? startA : startA + 1, beforeCount,
      afterStart: afterCount === 0 ? startB : startB + 1, afterCount,
      lines: Object.freeze(lines),
    }));
  }
  return hunks;
}

interface ScalarRun {
  readonly deletedStarts: number[];
  readonly deletedEnds: number[];
  readonly insertedStarts: number[];
  readonly insertedEnds: number[];
  readonly deletedTexts: string[];
  readonly insertedTexts: string[];
}

function scalarRuns(
  a: readonly string[], b: readonly string[], ops: readonly Opcode[], cancelled: Cancelled,
): ScalarRun {
  const deletedStarts: number[] = [];
  const deletedEnds: number[] = [];
  const insertedStarts: number[] = [];
  const insertedEnds: number[] = [];
  const deletedTexts: string[] = [];
  const insertedTexts: string[] = [];
  let deleted = "";
  let inserted = "";
  let delStart = 0;
  let insStart = 0;
  let delCursor = 0;
  let insCursor = 0;
  const flush = (): void => {
    if (!deleted && !inserted) return;
    deletedStarts.push(delStart);
    deletedEnds.push(delCursor);
    insertedStarts.push(insStart);
    insertedEnds.push(insCursor);
    deletedTexts.push(deleted);
    insertedTexts.push(inserted);
    deleted = "";
    inserted = "";
  };
  for (const op of ops) {
    cancelled();
    if (op.kind === "equal") {
      flush();
      delCursor = op.aEnd;
      insCursor = op.bEnd;
      continue;
    }
    // Myers opcodes skip equal runs; a non-adjacent opcode starts a new run.
    if (op.aStart > delCursor || op.bStart > insCursor) {
      flush();
      delCursor = op.aStart;
      insCursor = op.bStart;
    }
    if (!deleted && !inserted) { delStart = delCursor; insStart = insCursor; }
    if (op.kind === "delete") {
      const chunk = a.slice(op.aStart, op.aEnd).join("");
      deleted += chunk;
      delCursor = op.aEnd;
    } else {
      const chunk = b.slice(op.bStart, op.bEnd).join("");
      inserted += chunk;
      insCursor = op.bEnd;
    }
  }
  flush();
  return { deletedStarts, deletedEnds, insertedStarts, insertedEnds, deletedTexts, insertedTexts };
}

const utf16Prefix = (scalars: readonly string[]): number[] => {
  const offsets = [0];
  for (const scalar of scalars) offsets.push(offsets[offsets.length - 1]! + scalar.length);
  return offsets;
};

function intralineMarks(
  deleted: string, inserted: string, cancelled: Cancelled,
): readonly Readonly<{ before: readonly [number, number] | null; after: readonly [number, number] | null }>[] {
  const gd = graphemesOf(deleted);
  const gi = graphemesOf(inserted);
  const ops = diffSequence(gd, gi, (x, y) => x === y, cancelled);
  const runs = scalarRuns(gd, gi, ops, cancelled);
  const gdLen = utf16Prefix(gd);
  const giLen = utf16Prefix(gi);
  const marks: Readonly<{ before: readonly [number, number] | null; after: readonly [number, number] | null }>[] = [];
  for (let i = 0; i < runs.deletedTexts.length; i++) {
    marks.push(Object.freeze({
      before: runs.deletedTexts[i] ? Object.freeze([gdLen[runs.deletedStarts[i]!]!, gdLen[runs.deletedEnds[i]!]!] as const) : null,
      after: runs.insertedTexts[i] ? Object.freeze([giLen[runs.insertedStarts[i]!]!, giLen[runs.insertedEnds[i]!]!] as const) : null,
    }));
  }
  return Object.freeze(marks);
}

export interface ComputedDiff {
  readonly replacements: readonly DiffReplacement[];
  readonly hunks: readonly DiffHunk[];
}
export interface ComputeDiffInput {
  readonly document: DocumentId;
  readonly before: RevisionId | null;
  readonly after: RevisionId | null;
  readonly beforeText: string;
  readonly afterText: string;
  readonly contextLines: number;
  readonly intraline: "grapheme" | "none";
  readonly signal?: CancellationSignal;
}

export function computeDocumentDiff(input: ComputeDiffInput): ComputedDiff {
  const cancelled = cancellation(input.signal);
  cancelled();
  const beforeLines = splitPatchLines(input.beforeText);
  const afterLines = splitPatchLines(input.afterText);
  const ops = diffSequence(beforeLines, afterLines, lineEquals, cancelled);
  const hunks = buildHunks(beforeLines, afterLines, ops, input.contextLines);
  const beforeOffsets = lineOffsets(beforeLines);
  const afterOffsets = lineOffsets(afterLines);
  const range = (revision: RevisionId | null, start: number, end: number): TextRange | null =>
    revision === null ? null : Object.freeze({ document: input.document, revision, unit: "utf16" as const, start, end });
  const replacements: DiffReplacement[] = [];
  for (const block of blocksOf(ops)) {
    cancelled();
    const deletedText = joinPatchLines(beforeLines.slice(block.aStart, block.aEnd));
    const insertedText = joinPatchLines(afterLines.slice(block.bStart, block.bEnd));
    const beforeBase = beforeOffsets[block.aStart]!;
    const afterBase = afterOffsets[block.bStart]!;
    const delScalars = [...deletedText];
    const insScalars = [...insertedText];
    const scalarOps = diffSequence(delScalars, insScalars, (x, y) => x === y, cancelled);
    const runs = scalarRuns(delScalars, insScalars, scalarOps, cancelled);
    const delLen = utf16Prefix(delScalars);
    const insLen = utf16Prefix(insScalars);
    for (let i = 0; i < runs.deletedTexts.length; i++) {
      const deleted = runs.deletedTexts[i]!;
      const inserted = runs.insertedTexts[i]!;
      const beforeRange = deleted
        ? range(input.before, beforeBase + delLen[runs.deletedStarts[i]!]!, beforeBase + delLen[runs.deletedEnds[i]!]!) : null;
      const afterRange = inserted
        ? range(input.after, afterBase + insLen[runs.insertedStarts[i]!]!, afterBase + insLen[runs.insertedEnds[i]!]!) : null;
      const marks = input.intraline === "grapheme" && deleted && inserted
        ? intralineMarks(deleted, inserted, cancelled).map((mark) => Object.freeze({
          before: mark.before === null ? null : Object.freeze({
            document: input.document, revision: input.before!, unit: "utf16" as const,
            start: (beforeRange?.start ?? 0) + mark.before[0], end: (beforeRange?.start ?? 0) + mark.before[1],
          }),
          after: mark.after === null ? null : Object.freeze({
            document: input.document, revision: input.after!, unit: "utf16" as const,
            start: (afterRange?.start ?? 0) + mark.after[0], end: (afterRange?.start ?? 0) + mark.after[1],
          }),
        }))
        : [];
      replacements.push(Object.freeze({
        before: beforeRange, after: afterRange, deleted, inserted, intraline: Object.freeze(marks),
      }));
    }
  }
  return { replacements: Object.freeze(replacements), hunks: Object.freeze(hunks) };
}

export const DEFAULT_DIFF_CONTEXT_LINES: number = 3;
export const DEFAULT_DIFF_OUTPUT_BYTES: number = 16 * 1024 * 1024;

export interface ResolvedDiffOptions {
  readonly contextLines: number;
  readonly intraline: "grapheme" | "none";
  readonly maxOutputBytes: number;
}
export function resolveDiffOptions(options: DiffOptions): ResolvedDiffOptions {
  const contextLines = options.contextLines ?? DEFAULT_DIFF_CONTEXT_LINES;
  if (!Number.isSafeInteger(contextLines) || contextLines < 0 || contextLines > 1000) {
    throw new EditorError("INVALID_RANGE", "INVALID_RANGE: contextLines must be an integer between 0 and 1000");
  }
  const intraline = options.intraline ?? "grapheme";
  if (intraline !== "grapheme" && intraline !== "none") {
    throw new EditorError("INVALID_REFERENCE", "INVALID_REFERENCE: unknown intraline mode");
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_DIFF_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new EditorError("INVALID_RANGE", "INVALID_RANGE: maxOutputBytes must be a positive safe integer");
  }
  return Object.freeze({ contextLines, intraline, maxOutputBytes });
}

/**
 * Deterministic structured-size metric: every string's UTF-8 length plus a fixed
 * per-record overhead. The report and the formatted patch are refused, never
 * truncated, when they exceed the configured budget.
 */
export function measureReport(report: DiffReport): number {
  let total = 64;
  for (const entry of report.from.entries()) total += 32 + utf8Length(entry.revision);
  for (const entry of report.to.entries()) total += 32 + utf8Length(entry.revision);
  for (const tx of report.transactions) {
    total += 96 + utf8Length(tx.id) + utf8Length(tx.group) + utf8Length(tx.before) + utf8Length(tx.after) +
      utf8Length(tx.actor) + utf8Length(tx.origin.kind);
    if (tx.origin.label !== undefined) total += utf8Length(tx.origin.label);
    for (const id of tx.dependencies) total += 8 + utf8Length(id);
    for (const id of tx.operations) total += 8 + utf8Length(id);
    if (tx.attribution !== undefined) total += utf8Length(JSON.stringify(tx.attribution));
  }
  for (const doc of report.documents) {
    total += 64 + utf8Length(doc.document) + utf8Length(doc.beforeText) + utf8Length(doc.afterText);
    if (doc.before !== null) total += utf8Length(doc.before);
    if (doc.after !== null) total += utf8Length(doc.after);
    for (const replacement of doc.replacements) {
      total += 48 + utf8Length(replacement.deleted) + utf8Length(replacement.inserted) +
        (replacement.before ? 32 : 0) + (replacement.after ? 32 : 0) + replacement.intraline.length * 24;
    }
    for (const hunk of doc.hunks) {
      total += 32;
      for (const line of hunk.lines) total += 16 + utf8Length(line.text);
    }
  }
  return total;
}

function checkLabel(label: unknown): string {
  if (typeof label !== "string" || !label.length) {
    throw new EditorError("INVALID_DIFF_LABEL", "INVALID_DIFF_LABEL: labels must be nonempty strings");
  }
  for (const char of label) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      throw new EditorError("INVALID_DIFF_LABEL", "INVALID_DIFF_LABEL: labels must not contain control characters");
    }
  }
  return label;
}

function safeLabel(document: DocumentId): string {
  let printable = document.length > 0;
  for (const char of document) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code > 0x7e) { printable = false; break; }
  }
  return printable ? document : encodeURIComponent(document);
}

const hunkRange = (start: number, count: number): string => count === 1 ? `${start}` : `${start},${count}`;

export function formatUnifiedDiff(report: DiffReport, options: UnifiedDiffOptions = {}): string {
  if (report === null || typeof report !== "object" || report.schemaVersion !== 1) {
    throw new EditorError("UNSUPPORTED_FORMAT", "UNSUPPORTED_FORMAT: unsupported diff report schema");
  }
  const parts: string[] = [];
  for (const document of report.documents) {
    const labels = options.labels?.get(document.document);
    const before = document.before === null ? "/dev/null"
      : labels?.before !== undefined ? checkLabel(labels.before) : safeLabel(document.document);
    const after = document.after === null ? "/dev/null"
      : labels?.after !== undefined ? checkLabel(labels.after) : safeLabel(document.document);
    parts.push(`--- ${before}\n+++ ${after}\n`);
    for (const hunk of document.hunks) {
      parts.push(`@@ -${hunkRange(hunk.beforeStart, hunk.beforeCount)} +${hunkRange(hunk.afterStart, hunk.afterCount)} @@\n`);
      for (const line of hunk.lines) {
        parts.push(`${line.kind === "context" ? " " : line.kind === "delete" ? "-" : "+"}${line.text}\n`);
        if (!line.hasFinalLf) parts.push("\\ No newline at end of file\n");
      }
    }
  }
  const text = parts.join("");
  if (utf8Length(text) > report.maxOutputBytes) {
    throw new EditorError("LIMIT_EXCEEDED", "LIMIT_EXCEEDED: unified diff exceeds its output budget");
  }
  return text;
}
