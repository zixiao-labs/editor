import { expectTypeOf } from "@lightning-js/lightning";
import {
  documentId, externalBaseId, actorId, replicaId, selectionId, excerptId,
  type DocumentId, type ActorId, type RevisionId, type HeadStamp, type SelectionVersion,
  type TextPoint, type ProjectionPoint, type HeadCheckpoint, type SessionCheckpoint,
  type CoreFactories, type CollaborationFactories, type HistoryStore, type CommitReceipt,
  type SessionCommitReceipt, type DiffInput, type SelectionSnapshot, type CancellationSignal,
  createTextSource, textSourceFromHead, type TextReadVersion,
} from "../../src/index.js";

expectTypeOf(documentId("doc")).toEqualTypeOf<DocumentId>();
expectTypeOf<ActorId>().not.toEqualTypeOf<DocumentId>();
expectTypeOf<RevisionId>().not.toEqualTypeOf<HeadStamp>();
expectTypeOf<SelectionVersion>().not.toEqualTypeOf<HeadStamp>();
expectTypeOf<TextPoint>().not.toEqualTypeOf<ProjectionPoint>();
expectTypeOf<SessionCheckpoint>().not.toEqualTypeOf<HeadCheckpoint>();
expectTypeOf<SessionCommitReceipt>().toExtend<CommitReceipt>();

declare const api: CoreFactories;
declare const collaboration: CollaborationFactories;
declare const store: HistoryStore;
declare const oldHeadCheckpoint: HeadCheckpoint;
declare const sessionCheckpoint: SessionCheckpoint;
declare const receipt: CommitReceipt;
declare const sessionReceipt: SessionCommitReceipt;
declare const selections: SelectionSnapshot;
declare const signal: CancellationSignal;

const document = documentId("source");
const initial = store.createDocument({
  id: document, base: { id: externalBaseId("external:1"), text: "const n = 1;\n" },
});
const writer = store.openWriter({ actor: actorId("agent"), replica: replicaId("client") });
const head = store.fork({ at: store.revisions([initial]), writer });
const snapshot = head.snapshot(document);
const change = head.commit({
  expect: head.checkpoint(),
  edits: [{ document, range: snapshot.rangeUtf16(10, 11), text: "2" }],
  origin: { kind: "agent", label: "one-edit" },
});
const external = createTextSource({
  snapshot: () => ({ kind: "snapshot", lengthUtf16: 2, readUtf16: (a, b) => "AB".slice(a, b), dispose() {} }),
  onChange: () => ({ dispose() {} }),
});
const readonlyText = external.snapshot();
expectTypeOf(readonlyText.version).toEqualTypeOf<TextReadVersion>();
// @ts-expect-error Render versions are not causal revisions.
const causal: RevisionId = readonlyText.version;
head.commit({
  expect: head.checkpoint(), origin: { kind: "product" },
  // @ts-expect-error Render ranges cannot be used as source edit ranges.
  edits: [{ document, range: readonlyText.rangeUtf16(0, 1), text: "x" }],
});
// @ts-expect-error Render points cannot be converted as history coordinates.
snapshot.convertPoint(readonlyText.pointUtf16(0), "utf8");
textSourceFromHead(head, document);
void causal;
const session = api.createEditorSession({ target: head.document(document) });
session.selections.set({
  expect: session.selections.read().version,
  items: [{
    id: selectionId("caret"),
    anchor: { document, position: snapshot.anchorUtf16(0, { affinity: "before" }) },
    head: { document, position: snapshot.anchorUtf16(0, { affinity: "before" }) },
  }],
  primary: selectionId("caret"), origin: { kind: "product" },
});
session.replaceSelections({
  expect: session.checkpoint(), replacement: { kind: "uniform", text: "hello" },
  origin: { kind: "agent" },
});
const projection = api.createMultiBuffer({
  head,
  excerpts: [{
    id: excerptId("one"), document,
    range: snapshot.stableRangeUtf16(0, 5, { startAffinity: "before", endAffinity: "after" }),
  }],
});
const offer = collaboration.createHistorySyncPort({ store, documents: [document] })
  .offer({ target: change.after.revisions });
offer.exportMissing({ known: { revisions: head.checkpoint().revisions } });
store.diff({ change: receipt, signal });
store.diff({ change: sessionReceipt });
store.diff({ from: change.before.revisions, to: change.after.revisions });
const input: DiffInput = { change };
expectTypeOf(input).toExtend<DiffInput>();
expectTypeOf(projection.snapshot().fromSource({
  document, position: snapshot.anchorUtf16(0, { affinity: "after" }),
})).toExtend<readonly unknown[]>();

// @ts-expect-error A string is not a validated identity.
const raw: DocumentId = "source";
// @ts-expect-error An actor cannot be used as a document.
store.snapshot({ document: actorId("agent"), revision: initial.revision });
// @ts-expect-error The two Diff boundaries cannot be mixed.
store.diff({ change, from: change.before.revisions, to: change.after.revisions });
// @ts-expect-error Source head CAS cannot consume session/selection CAS.
head.merge({ expect: sessionCheckpoint, source: change.after.revisions });
session.replaceSelections({
  // @ts-expect-error Session writes require the complete session checkpoint.
  expect: oldHeadCheckpoint, replacement: { kind: "uniform", text: "" }, origin: { kind: "product" },
});
// @ts-expect-error Source offset is not a projection point.
projection.snapshot().toSource(snapshot.pointUtf16(0));
// @ts-expect-error Selections must be immutable to consumers.
selections.items.push(selections.items[0]!);
// @ts-expect-error Receipts cannot be constructed by product code.
const forged: CommitReceipt = { before: change.before, after: change.after, status: "committed" };
void raw;
void forged;
