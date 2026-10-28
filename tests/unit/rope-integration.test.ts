import { expect, test } from "@lightning-js/lightning";
import { TextIndex } from "../../src/coordinates/text-index.js";
import { NativeHistory } from "../../src/history/native-history.js";
import { NativeStore } from "../../src/history/native-store.js";
import { NativeWriter } from "../../src/history/identity.js";
import { actorId, documentId, externalBaseId, replicaId } from "../../src/identity.js";
import { SourceRevision } from "../../src/model/source-revision.js";
import { TextRope, CHUNK_MAX, type RopeChunk, type TextSummary } from "../../src/text/rope.js";
import type { SumNode } from "../../src/collections/sum-tree.js";

const document = documentId("rope:document");
const base = externalBaseId("rope:base");
function references(root: SumNode<RopeChunk, TextSummary> | null): Set<object> {
  const result = new Set<object>();
  const visit = (node: SumNode<RopeChunk, TextSummary>) => {
    result.add(node);
    if (node.kind === "branch") for (const child of node.children) visit(child);
  };
  if (root) visit(root);
  return result;
}

test("TextIndex and source snapshots consume the same persistent rope without a flat prefix rebuild", () => {
  const rope = TextRope.from("A😀\r\nB");
  const index = new TextIndex(rope);
  expect(index.convert(5, "utf8", "scalar")).toBe(2);
  const history = new NativeHistory({ document, base, text: "A😀\r\nB" });
  const elements = history.elements(history.initial);
  const source = new SourceRevision({ document, root: history.root.id, revision: history.initial, elements, text: rope });
  expect(source.snapshot().convertPoint(source.snapshot().pointUtf8(5), "utf16").offset).toBe(3);
  expect(source.snapshot().text()).toBe("A😀\r\nB");
  expect(() => new SourceRevision({
    document, root: history.root.id, revision: history.initial, elements, text: TextRope.from("different"),
  })).toThrow("INVALID_REFERENCE");
});

test("accepted native writes and staged clones retain shared rope roots and immutable source views", () => {
  const history = new NativeHistory({ document, base, text: "A".repeat(CHUNK_MAX * 128) });
  const original = history.text(history.initial);
  const source = history.source(history.initial);
  const writer = new NativeWriter({
    actor: actorId("writer"), replica: replicaId("replica"), random: { fill(bytes) { bytes.fill(40); } },
  });
  const staged = history.clone();
  expect(staged.root).toBe(history.root);
  expect(staged.text(history.initial)).toBe(original);
  expect(staged.source(history.initial)).toBe(source);
  const tx = staged.prepare({
    at: staged.initial, writer, origin: { kind: "rope" },
    edits: [{ range: source.snapshot().rangeUtf16(CHUNK_MAX * 64, CHUNK_MAX * 64 + 1), text: "😀" }],
  })!;
  staged.accept([tx]);
  const at = staged.revision([tx.id]);
  const changed = staged.text(at);
  expect(changed.summary.utf16).toBe(original.summary.utf16 + 1);
  expect(changed.slice(CHUNK_MAX * 64 - 1, CHUNK_MAX * 64 + 3).toString()).toBe("A😀A");
  const oldNodes = references(original.debugRoot());
  const changedNodes = references(changed.debugRoot());
  const shared = [...changedNodes].filter((node) => oldNodes.has(node)).length;
  // This small tree has only nine original nodes: boundary redistribution may
  // copy several leaves. Assert real sharing and a bounded fringe, not a
  // misleading percentage. The million-unit rope test checks the large case.
  expect(shared > 0).toBe(true);
  expect(changedNodes.size - shared < 32).toBe(true);
  expect(history.text(history.initial)).toBe(original);
  expect(staged.source(at)).toBe(staged.source(at));
  expect(source.snapshot().lengthUtf16).toBe(original.summary.utf16);
  // A detached typed import materializes independently; it cannot trust a local
  // draft's private rope cache, but must compute precisely the same text.
  const imported = new NativeHistory({ document, base, text: history.root.text });
  imported.accept([JSON.parse(JSON.stringify(tx))]);
  expect(imported.text(imported.revision([tx.id])).equals(changed)).toBe(true);
});

test("real head commits and coordinate queries never implicitly flatten the text rope", () => {
  let stream = 1;
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(stream++); } } });
  const initial = store.createDocument({ id: document, base: { id: base, text: "A😀\r\nB" } });
  const writer = store.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = store.fork({ at: store.revisions([initial]), writer });
  const original = TextRope.prototype.toString;
  const replace = TextRope.prototype.replace;
  let writes = 0;
  TextRope.prototype.toString = () => { throw new Error("implicit flatten"); };
  TextRope.prototype.replace = function (...args: Parameters<TextRope["replace"]>): TextRope {
    writes++; return replace.apply(this, args);
  };
  try {
    const snapshot = head.snapshot(document);
    const receipt = head.commit({
      expect: head.checkpoint(), origin: { kind: "no-flatten" },
      edits: [{ document, range: snapshot.rangeUtf16(1, 3), text: "中" }],
    });
    const current = head.snapshot(document);
    expect(current.lengthUtf16).toBe(5);
    expect(current.convertPoint(current.pointUtf8(4), "scalar").offset).toBe(2);
    const result = store.history.compare({
      document, left: initial.revision, right: receipt.after.revisions.get(document),
    });
    expect(result).toBe("ancestor");
    expect(writes > 0).toBe(true);
    snapshot.dispose(); current.dispose();
  } finally { TextRope.prototype.toString = original; TextRope.prototype.replace = replace; }
  const snapshot = head.snapshot(document);
  expect(snapshot.text()).toBe("A中\r\nB");
  snapshot.dispose(); head.dispose(); writer.dispose(); store.dispose();
});
