import { expect, test } from "@lightning-js/lightning";
import {
  createHistoryStore, formatUnifiedDiff, documentId, externalBaseId, actorId, replicaId,
} from "../../src/index.js";
import type {
  CommitReceipt, DiffHunk, DiffReport, DiffOptions, EditingHead, HistoryStore, RevisionSet, SourceEdit,
} from "../../src/index.js";

const document = documentId("diff:document");
const second = documentId("diff:second");
const base = externalBaseId("diff:base");
let serial = 5_000;
function store(): HistoryStore {
  return createHistoryStore({ random: { fill(bytes) { bytes.fill(serial++); } } });
}
function setup(text: string) {
  const s = store();
  const initial = s.createDocument({ id: document, base: { id: base, text } });
  const writer = s.openWriter({ actor: actorId("diff"), replica: replicaId("diff") });
  const head = s.fork({ at: s.revisions([initial]), writer });
  const dispose = () => { head.dispose(); writer.dispose(); s.dispose(); };
  return { s, initial, writer, head, dispose };
}
function replaceAll(head: EditingHead, next: string, id = document): CommitReceipt {
  const snapshot = head.snapshot(id);
  try {
    return head.commit({
      expect: head.checkpoint(), origin: { kind: "diff" },
      edits: [{ document: id, range: snapshot.rangeUtf16(0, snapshot.lengthUtf16), text: next }],
    });
  } finally { snapshot.dispose(); }
}
function contents(head: EditingHead, id = document): string {
  const snapshot = head.snapshot(id);
  try { return snapshot.text(); } finally { snapshot.dispose(); }
}
async function failure(action: () => Promise<unknown>): Promise<string | undefined> {
  try { await action(); return undefined; } catch (cause) { return (cause as { code?: string }).code; }
}
function codeOf(action: () => unknown): string | undefined {
  try { action(); return undefined; } catch (cause) { return (cause as { code?: string }).code; }
}

// ---- Independent readers: rebuild the after text from the report and from the patch text. ----
interface PatchLine { readonly text: string; readonly hasFinalLf: boolean }
function splitPatchLines(text: string): PatchLine[] {
  if (!text) return [];
  const parts = text.split("\n");
  const lines: PatchLine[] = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (last && parts[i] === "") break;
    lines.push({ text: parts[i]!, hasFinalLf: !last });
  }
  return lines;
}
const joinPatchLines = (lines: readonly PatchLine[]): string =>
  lines.map((line) => line.text + (line.hasFinalLf ? "\n" : "")).join("");
function applyHunks(beforeText: string, hunks: readonly DiffHunk[]): string {
  const before = splitPatchLines(beforeText);
  const out: PatchLine[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = hunk.beforeCount === 0 ? hunk.beforeStart : hunk.beforeStart - 1;
    if (start < cursor) throw new Error("overlapping hunks");
    while (cursor < start) out.push(before[cursor++]!);
    let beforeSeen = 0, afterSeen = 0;
    for (const line of hunk.lines) {
      if (line.kind === "insert") { out.push({ text: line.text, hasFinalLf: line.hasFinalLf }); afterSeen++; continue; }
      const current = before[cursor++];
      if (!current || current.text !== line.text || current.hasFinalLf !== line.hasFinalLf) {
        throw new Error(`hunk line does not match before text: ${JSON.stringify(line.text)}`);
      }
      beforeSeen++;
      if (line.kind === "context") { out.push(current); afterSeen++; }
    }
    if (beforeSeen !== hunk.beforeCount || afterSeen !== hunk.afterCount) throw new Error("hunk counts disagree with lines");
  }
  while (cursor < before.length) out.push(before[cursor++]!);
  return joinPatchLines(out);
}
function parseUnified(patch: string): { readonly before: string; readonly after: string; readonly hunks: DiffHunk[] }[] {
  const lines = patch.split("\n");
  if (lines[lines.length - 1] !== "") throw new Error("patch must end with a newline");
  lines.pop();
  const documents: { before: string; after: string; hunks: DiffHunk[] }[] = [];
  let hunk: { beforeStart: number; beforeCount: number; afterStart: number; afterCount: number; lines: { kind: "context" | "insert" | "delete"; text: string; hasFinalLf: boolean }[] } | null = null;
  for (const line of lines) {
    if (line.startsWith("--- ")) { documents.push({ before: line.slice(4), after: "", hunks: [] }); hunk = null; continue; }
    if (line.startsWith("+++ ")) { documents[documents.length - 1]!.after = line.slice(4); continue; }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/u.exec(line);
    if (header) {
      hunk = {
        beforeStart: Number(header[1]), beforeCount: header[2] === undefined ? 1 : Number(header[2]),
        afterStart: Number(header[3]), afterCount: header[4] === undefined ? 1 : Number(header[4]), lines: [],
      };
      documents[documents.length - 1]!.hunks.push(hunk as unknown as DiffHunk);
      continue;
    }
    if (!hunk) throw new Error(`unexpected patch line: ${line}`);
    if (line === "\\ No newline at end of file") {
      const previous = hunk.lines[hunk.lines.length - 1];
      if (!previous) throw new Error("marker without a line");
      previous.hasFinalLf = false;
      continue;
    }
    const prefix = line[0];
    const kind = prefix === " " ? "context" : prefix === "-" ? "delete" : prefix === "+" ? "insert" : null;
    if (!kind) throw new Error(`unknown prefix: ${line}`);
    hunk.lines.push({ kind, text: line.slice(1), hasFinalLf: true });
  }
  return documents;
}
function rebuild(report: DiffReport): { readonly structural: string[]; readonly textual: string[] } {
  const structural = report.documents.map((doc) => applyHunks(doc.beforeText, doc.hunks));
  const parsed = parseUnified(formatUnifiedDiff(report));
  expect(parsed.length).toBe(report.documents.length);
  const textual = parsed.map((doc, i) => applyHunks(report.documents[i]!.beforeText, doc.hunks));
  return { structural, textual };
}

test("line replacements produce exact hunks, numbering, replacements and a deterministic unified patch", async () => {
  const { s, head, dispose } = setup("one\ntwo\nthree\nfour\nfive\n");
  const change = replaceAll(head, "one\ntwo\nTHREE\nfour\nfive\n");
  const report = await s.diff({ change });
  expect(report.schemaVersion).toBe(1);
  expect(report.basis).toBe("commit");
  expect(report.maxOutputBytes).toBe(16 * 1024 * 1024);
  expect(report.from.get(document)).toBe(change.before.revisions.get(document));
  expect(report.to.get(document)).toBe(change.after.revisions.get(document));
  expect(report.transactions.map((tx) => tx.id)).toEqual(change.transactions);
  expect(report.documents.length).toBe(1);
  const doc = report.documents[0]!;
  expect(doc.kind).toBe("modified");
  expect(doc.before).toBe(change.before.revisions.get(document));
  expect(doc.after).toBe(change.after.revisions.get(document));
  expect(doc.beforeText).toBe("one\ntwo\nthree\nfour\nfive\n");
  expect(doc.afterText).toBe("one\ntwo\nTHREE\nfour\nfive\n");
  expect(doc.hunks.length).toBe(1);
  const hunk = doc.hunks[0]!;
  expect([hunk.beforeStart, hunk.beforeCount, hunk.afterStart, hunk.afterCount]).toEqual([1, 5, 1, 5]);
  expect(hunk.lines.map((line) => line.kind)).toEqual(["context", "context", "delete", "insert", "context", "context"]);
  expect(hunk.lines[0]).toEqual({ kind: "context", text: "one", hasFinalLf: true, beforeLine: 1, afterLine: 1 });
  expect(hunk.lines[2]).toEqual({ kind: "delete", text: "three", hasFinalLf: true, beforeLine: 3, afterLine: null });
  expect(hunk.lines[3]).toEqual({ kind: "insert", text: "THREE", hasFinalLf: true, beforeLine: null, afterLine: 3 });
  expect(hunk.lines[5]).toEqual({ kind: "context", text: "five", hasFinalLf: true, beforeLine: 5, afterLine: 5 });
  expect(doc.replacements.length).toBe(1);
  const replacement = doc.replacements[0]!;
  expect(replacement.deleted).toBe("three");
  expect(replacement.inserted).toBe("THREE");
  expect(replacement.before).toEqual({ document, revision: doc.before, unit: "utf16", start: 8, end: 13 });
  expect(replacement.after).toEqual({ document, revision: doc.after, unit: "utf16", start: 8, end: 13 });
  expect(replacement.intraline).toEqual([{ before: replacement.before, after: replacement.after }]);
  const unified = formatUnifiedDiff(report);
  expect(unified).toBe("--- diff:document\n+++ diff:document\n@@ -1,5 +1,5 @@\n one\n two\n-three\n+THREE\n four\n five\n");
  expect(formatUnifiedDiff(await s.diff({ change }))).toBe(unified);
  expect(rebuild(report)).toEqual({ structural: [doc.afterText], textual: [doc.afterText] });
  expect(Object.isFrozen(report) && Object.isFrozen(report.documents) && Object.isFrozen(hunk.lines)).toBe(true);
  dispose();
});

test("versions basis lists causal differences, membership changes and empty results", async () => {
  const { s, initial, head, writer, dispose } = setup("AB");
  const snapshot = head.snapshot(document);
  const one = head.commit({ expect: head.checkpoint(), origin: { kind: "one" }, edits: [{ document, range: snapshot.rangeUtf16(0, 0), text: "X" }] });
  snapshot.dispose();
  const later = head.snapshot(document);
  const two = head.commit({ expect: head.checkpoint(), origin: { kind: "two" }, edits: [{ document, range: later.rangeUtf16(1, 1), text: "Y" }] });
  later.dispose();
  const report = await s.diff({ from: s.revisions([initial]), to: two.after.revisions });
  expect(report.basis).toBe("versions");
  expect(report.transactions.map((tx) => tx.id)).toEqual([...one.transactions, ...two.transactions]);
  expect(report.documents[0]!.replacements).toEqual([{
    before: null, after: { document, revision: two.after.revisions.get(document), unit: "utf16", start: 0, end: 2 },
    deleted: "", inserted: "XY", intraline: [],
  }]);
  const extra = s.createDocument({ id: second, base: { id: base, text: "Z" } });
  const added = await s.diff({ from: s.revisions([initial]), to: s.revisions([{ document, revision: two.after.revisions.get(document) }, extra]) });
  expect(added.documents.map((doc) => [doc.document, doc.kind])).toEqual([[document, "modified"], [second, "added"]]);
  const addedDoc = added.documents[1]!;
  expect([addedDoc.before, addedDoc.after, addedDoc.beforeText, addedDoc.afterText]).toEqual([null, extra.revision, "", "Z"]);
  expect(addedDoc.hunks).toEqual([{
    beforeStart: 0, beforeCount: 0, afterStart: 1, afterCount: 1,
    lines: [{ kind: "insert", text: "Z", hasFinalLf: false, beforeLine: null, afterLine: 1 }],
  }]);
  expect(addedDoc.replacements[0]!.before).toBe(null);
  expect(formatUnifiedDiff(added)).toContain("--- /dev/null\n+++ diff:second\n@@ -0,0 +1 @@\n+Z\n\\ No newline at end of file\n");
  const removed = await s.diff({ from: s.revisions([initial, extra]), to: s.revisions([initial]) });
  expect(removed.documents.map((doc) => [doc.document, doc.kind, doc.after, doc.afterText])).toEqual([[second, "removed", null, ""]]);
  expect(formatUnifiedDiff(removed)).toBe("--- diff:second\n+++ /dev/null\n@@ -1 +0,0 @@\n-Z\n\\ No newline at end of file\n");
  expect((await s.diff({ from: s.revisions([initial]), to: s.revisions([initial]) })).documents).toEqual([]);
  const noChange = head.commit({ expect: head.checkpoint(), origin: { kind: "none" }, edits: [] });
  expect((await s.diff({ change: noChange })).documents).toEqual([]);
  expect(formatUnifiedDiff(await s.diff({ change: noChange }))).toBe("");
  void writer;
  dispose();
});

test("line endings and final newlines are preserved exactly, never normalized", async () => {
  const cases: readonly (readonly [string, string, string, Partial<DiffOptions>?])[] = [
    ["a\r\nb\r\n", "a\r\nc\r\n", "--- diff:document\n+++ diff:document\n@@ -1,2 +1,2 @@\n a\r\n-b\r\n+c\r\n"],
    ["a\nb", "a\nc", "--- diff:document\n+++ diff:document\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n"],
    ["a\n", "a", "--- diff:document\n+++ diff:document\n@@ -1 +1 @@\n-a\n+a\n\\ No newline at end of file\n"],
    ["x\ry", "x\rz", "--- diff:document\n+++ diff:document\n@@ -1 +1 @@\n-x\ry\n\\ No newline at end of file\n+x\rz\n\\ No newline at end of file\n"],
    ["a\n", "a\nb\n", "--- diff:document\n+++ diff:document\n@@ -1,0 +2 @@\n+b\n", { contextLines: 0 }],
    ["a\nb\nc\n", "", "--- diff:document\n+++ diff:document\n@@ -1,3 +0,0 @@\n-a\n-b\n-c\n"],
    ["", "a\n", "--- diff:document\n+++ diff:document\n@@ -0,0 +1 @@\n+a\n"],
  ];
  for (const [before, after, golden, options] of cases) {
    const { s, head, dispose } = setup(before);
    const change = replaceAll(head, after);
    const report = await s.diff({ change, ...options });
    expect(formatUnifiedDiff(report)).toBe(golden);
    expect(rebuild(report)).toEqual({ structural: [after], textual: [after] });
    expect(report.documents[0]!.beforeText).toBe(before);
    expect(report.documents[0]!.afterText).toBe(after);
    dispose();
  }
});

test("intraline marks are grapheme aligned and scalar safe; none disables them", async () => {
  const check = async (before: string, after: string, options: Partial<DiffOptions> = {}) => {
    const { s, head, dispose } = setup(before);
    const change = replaceAll(head, after);
    const report = await s.diff({ change, ...options });
    const doc = report.documents[0]!;
    for (const replacement of doc.replacements) {
      if (replacement.before) expect(doc.beforeText.slice(replacement.before.start, replacement.before.end)).toBe(replacement.deleted);
      if (replacement.after) expect(doc.afterText.slice(replacement.after.start, replacement.after.end)).toBe(replacement.inserted);
      for (const mark of replacement.intraline) {
        if (mark.before) expect(mark.before.start >= replacement.before!.start && mark.before.end <= replacement.before!.end).toBe(true);
        if (mark.after) expect(mark.after.start >= replacement.after!.start && mark.after.end <= replacement.after!.end).toBe(true);
      }
    }
    dispose();
    return doc;
  };
  const insertion = await check("const value = 1;", "const value = 12;");
  expect(insertion.replacements).toEqual([{
    before: null, after: { document, revision: insertion.after, unit: "utf16", start: 15, end: 16 },
    deleted: "", inserted: "2", intraline: [],
  }]);
  const composed = await check("café", "café");
  expect(composed.replacements.map((r) => [r.before!.start, r.before!.end, r.after!.start, r.after!.end, r.deleted, r.inserted]))
    .toEqual([[3, 4, 3, 5, "é", "é"]]);
  expect(composed.replacements[0]!.intraline).toEqual([{ before: composed.replacements[0]!.before, after: composed.replacements[0]!.after }]);
  const emoji = await check("a😀b", "a🙂b");
  expect(emoji.replacements.map((r) => [r.before!.start, r.before!.end, r.deleted, r.inserted])).toEqual([[1, 3, "😀", "🙂"]]);
  const partial = await check("x1y", "X1Y");
  expect(partial.replacements.map((r) => [r.deleted, r.inserted])).toEqual([["x", "X"], ["y", "Y"]]);
  expect(partial.replacements.map((r) => r.intraline.length)).toEqual([1, 1]);
  const plain = await check("x1y", "X1Y", { intraline: "none" });
  expect(plain.replacements[0]!.intraline).toEqual([]);
  const separate = await check("abc", "aXc");
  expect(separate.replacements.map((r) => [r.deleted, r.inserted])).toEqual([["b", "X"]]);
});

test("labels, budgets, options and cancellation fail precisely without truncation", async () => {
  const { s, initial, head, dispose } = setup("a\n");
  const change = replaceAll(head, "b\n");
  const report = await s.diff({ change });
  expect(formatUnifiedDiff(report, { labels: new Map([[document, { before: "a/file.txt", after: "b/file.txt" }]]) }))
    .toBe("--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-a\n+b\n");
  expect(formatUnifiedDiff(report, { labels: new Map([[second, { before: "ignored", after: "ignored" }]]) }))
    .toBe("--- diff:document\n+++ diff:document\n@@ -1 +1 @@\n-a\n+b\n");
  for (const bad of ["a\nb", "a\u0000", "a\r", ""]) {
    expect(codeOf(() => formatUnifiedDiff(report, { labels: new Map([[document, { before: bad, after: "ok" }]]) }))).toBe("INVALID_DIFF_LABEL");
  }
  expect(await failure(() => s.diff({ change, maxOutputBytes: 16 }))).toBe("LIMIT_EXCEEDED");
  for (const value of [-1, 0, 1.5]) expect(await failure(() => s.diff({ change, maxOutputBytes: value }))).toBe("INVALID_RANGE");
  for (const value of [-1, 1001, 1.5]) expect(await failure(() => s.diff({ change, contextLines: value }))).toBe("INVALID_RANGE");
  expect(await failure(() => s.diff({ change, intraline: "words" as "none" }))).toBe("INVALID_REFERENCE");
  const bounded = await s.diff({ change, maxOutputBytes: 200_000 });
  expect(codeOf(() => formatUnifiedDiff(bounded, { labels: new Map([[document, { before: "x".repeat(200_001), after: "y" }]]) })))
    .toBe("LIMIT_EXCEEDED");
  expect(await failure(() => s.diff({
    change, signal: { aborted: true, addEventListener() {}, removeEventListener() {} },
  }))).toBe("CANCELLED");
  const other = setup("a\n");
  expect(await failure(() => s.diff({ change: other.head.commit({ expect: other.head.checkpoint(), origin: { kind: "x" }, edits: [] }) })))
    .toBe("INVALID_REFERENCE");
  expect(await failure(() => s.diff({ change, from: change.before.revisions, to: change.after.revisions } as never))).toBe("INVALID_REFERENCE");
  const unknown = String(initial.revision).replace(/[0-9a-f]$/u, (c) => c === "0" ? "1" : "0");
  expect(await failure(() => s.diff({ from: s.revisions([initial]), to: { ...s.revisions([initial]), get: () => unknown as never, entries: () => [{ document, revision: unknown as never }][Symbol.iterator]() } as RevisionSet })))
    .toBe("UNKNOWN_REVISION");
  other.dispose();
  dispose();
});

test("randomized edits stay reconstructable through hunks, patches, replacements and marks", async () => {
  let seed = 424242;
  const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const pool = ["a", "b", "c", "😀", "é", "é", "\n", "\r\n", "\r", "\t", " ", "中"];
  const { s, initial, head, dispose } = setup("alpha\nbeta\n");
  for (let iteration = 0; iteration < 30; iteration++) {
    const snapshot = head.snapshot(document);
    const scalars = [...snapshot.text()].length;
    const i = Math.floor(random() * (scalars + 1));
    const j = Math.min(scalars, i + Math.floor(random() * 4));
    const start = snapshot.convertPoint(snapshot.pointScalar(i), "utf16").offset;
    const end = snapshot.convertPoint(snapshot.pointScalar(j), "utf16").offset;
    const text = random() < 0.3 ? "" : Array.from({ length: 1 + Math.floor(random() * 4) }, () => pool[Math.floor(random() * pool.length)]!).join("");
    const edits: SourceEdit[] = [{ document, range: snapshot.rangeUtf16(start, end), text }];
    snapshot.dispose();
    head.commit({ expect: head.checkpoint(), origin: { kind: "random" }, edits });
    const current = contents(head);
    const report = await s.diff({ from: s.revisions([initial]), to: head.checkpoint().revisions, contextLines: iteration % 4 });
    if (current === "alpha\nbeta\n") { expect(report.documents).toEqual([]); continue; }
    const doc = report.documents[0]!;
    expect(doc.afterText).toBe(current);
    expect(rebuild(report)).toEqual({ structural: [current], textual: [current] });
    let previousEnd = -1;
    for (const replacement of doc.replacements) {
      if (replacement.before) {
        expect(doc.beforeText.slice(replacement.before.start, replacement.before.end)).toBe(replacement.deleted);
        expect(replacement.before.start > previousEnd).toBe(true);
        previousEnd = replacement.before.end;
      } else expect(replacement.deleted).toBe("");
      if (replacement.after) expect(doc.afterText.slice(replacement.after.start, replacement.after.end)).toBe(replacement.inserted);
      else expect(replacement.inserted).toBe("");
      for (const mark of replacement.intraline) {
        expect(mark.before !== null || mark.after !== null).toBe(true);
        if (mark.before) expect(doc.beforeText.slice(mark.before.start, mark.before.end).length).toBeGreaterThan(0);
        if (mark.after) expect(doc.afterText.slice(mark.after.start, mark.after.end).length).toBeGreaterThan(0);
      }
    }
    for (let h = 1; h < doc.hunks.length; h++) expect(doc.hunks[h]!.beforeStart > doc.hunks[h - 1]!.beforeStart).toBe(true);
  }
  dispose();
});
