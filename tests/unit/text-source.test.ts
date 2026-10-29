import { expect, test } from "@lightning-js/lightning";
import { createTextSource, textSourceFromHead } from "../../src/index.js";
import { NativeStore } from "../../src/history/native-store.js";
import { actorId, documentId, externalBaseId, replicaId } from "../../src/identity.js";
import { TextRope } from "../../src/text/rope.js";

/** Real two-sided gap storage used only as a product fixture, not library-owned text. */
class GapBuffer {
  left: string[] = [];
  right: string[];
  version = 0;
  readonly listeners = new Set<() => void>();
  readonly reads: [number, number][] = [];
  constructor(text: string) { this.right = text.split("").reverse(); }
  get length(): number { return this.left.length + this.right.length; }
  read(start: number, end: number): string {
    this.reads.push([start, end]);
    let text = "";
    for (let i = start; i < end; i++) text += i < this.left.length ? this.left[i]! : this.right[this.length - i - 1]!;
    return text;
  }
  insert(offset: number, text: string): void {
    while (this.left.length < offset) this.left.push(this.right.pop()!);
    while (this.left.length > offset) this.right.push(this.left.pop()!);
    this.left.push(...text.split("")); this.version++;
    for (const listener of this.listeners) listener();
  }
  erase(start: number, end: number): void {
    while (this.left.length < start) this.left.push(this.right.pop()!);
    while (this.left.length > start) this.right.push(this.left.pop()!);
    for (let i = start; i < end; i++) this.right.pop();
    this.version++;
    for (const listener of this.listeners) listener();
  }
  source() {
    return createTextSource({
      snapshot: () => {
        const version = this.version;
        return { kind: "versioned", lengthUtf16: this.length, isCurrent: () => this.version === version,
          readUtf16: (start: number, end: number) => this.read(start, end), dispose() {} };
      },
      onChange: (listener) => {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
      },
    });
  }
}

test("a product gap buffer supplies bounded Unicode reads without history, anchors or a full text copy", () => {
  const buffer = new GapBuffer("x".repeat(100_000) + "😀\r\n");
  buffer.insert(50_000, "中");
  const source = buffer.source(), snapshot = source.snapshot();
  expect(snapshot.readUtf16(49_999, 50_002)).toBe("x中x");
  expect(buffer.reads.every(([a, b]) => b - a <= 3)).toBe(true);
  expect(snapshot.read(snapshot.rangeUtf16(100_001, 100_003))).toBe("😀");
  expect(() => snapshot.pointUtf16(100_002)).toThrow("INVALID_BOUNDARY");
  expect(snapshot.readUtf16(100_003, 100_005)).toBe("\r\n");
  expect(() => source.dispose()).toThrow("RESOURCE_IN_USE");
  snapshot.dispose(); source.dispose();
  expect(buffer.listeners.size).toBe(0);
  buffer.insert(0, "product still owns storage");
});

test("mutable read leases reject mutation/ABA and never return a torn read", () => {
  const buffer = new GapBuffer("AB"), source = buffer.source();
  const old = source.snapshot();
  buffer.insert(1, "x");
  buffer.erase(1, 2);
  expect(buffer.read(0, buffer.length)).toBe("AB");
  expect(source.isCurrent(old)).toBe(false);
  expect(() => old.readUtf16(0, 1)).toThrow("STALE_TEXT_VIEW");
  old.dispose();
  const next = source.snapshot();
  const other = source.snapshot();
  expect(() => next.read(other.rangeUtf16(0, 1))).toThrow("WRONG_TEXT_VIEW");
  next.dispose(); other.dispose(); source.dispose();
  let stamp = 0;
  const torn = createTextSource({
    snapshot: () => ({ kind: "versioned", lengthUtf16: 2, isCurrent: () => stamp === 0,
      readUtf16(a, b) { stamp++; return "AB".slice(a, b); }, dispose() {} }),
    onChange: () => ({ dispose() {} }),
  });
  const read = torn.snapshot();
  expect(() => read.readUtf16(0, 2)).toThrow("STALE_TEXT_VIEW");
  read.dispose(); torn.dispose();
});

test("persistent product snapshots remain readable while invalidations supersede them and subscriptions stay independent", async () => {
  let text = "old";
  const callbacks = new Set<() => void>();
  const source = createTextSource({
    snapshot() { const captured = text; return { kind: "snapshot", lengthUtf16: captured.length, readUtf16: (a, b) => captured.slice(a, b), dispose() {} }; },
    onChange(listener) { callbacks.add(listener); return { dispose() { callbacks.delete(listener); } }; },
  });
  let notifications = 0;
  const listener = () => { notifications++; };
  const first = source.onChange(listener), second = source.onChange(listener);
  const old = source.snapshot();
  text = "new"; callbacks.forEach((listener) => listener()); callbacks.forEach((listener) => listener());
  first.dispose();
  await Promise.resolve();
  expect(notifications).toBe(1);
  expect(source.isCurrent(old)).toBe(false);
  expect(old.readUtf16(0, 3)).toBe("old");
  old.dispose(); second.dispose(); source.dispose();
  expect(() => source.snapshot()).toThrow("DISPOSED");
});

test("read ports reject malformed slices/Unicode, released snapshots and foreign ranges", () => {
  const source = createTextSource({
    snapshot: () => ({ kind: "snapshot", lengthUtf16: 1, readUtf16: () => "\ud800", dispose() {} }),
    onChange: () => ({ dispose() {} }),
  });
  const snapshot = source.snapshot();
  expect(() => snapshot.readUtf16(0, 1)).toThrow("INVALID_UNICODE");
  expect(() => snapshot.readUtf16(-1, 0)).toThrow("INVALID_RANGE");
  snapshot.dispose(); snapshot.dispose();
  expect(() => snapshot.readUtf16(0, 0)).toThrow("DISPOSED");
  source.dispose();
});

test("full history feeds the same read port via partial rope reads without flattening the document", () => {
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(1); } } });
  const document = documentId("render");
  const initial = store.createDocument({ id: document, base: { id: externalBaseId("base"), text: "a".repeat(100_000) + "😀a😀\r\n" } });
  const writer = store.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = store.fork({ at: store.revisions([initial]), writer });
  const source = textSourceFromHead(head, document), snapshot = source.snapshot();
  const flatten = TextRope.prototype.toString;
  TextRope.prototype.toString = function () {
    if (this.summary.utf16 > 16) throw new Error("unexpected whole-document copy");
    return flatten.call(this);
  };
  try {
    expect(snapshot.readUtf16(49_999, 50_002)).toBe("aaa");
    expect(snapshot.readUtf16(100_000, 100_002)).toBe("😀");
    expect(snapshot.readUtf16(100_002, 100_003)).toBe("a");
    expect(snapshot.readUtf16(100_003, 100_007)).toBe("😀\r\n");
    expect(() => snapshot.pointUtf16(100_001)).toThrow("INVALID_BOUNDARY");
  }
  finally { TextRope.prototype.toString = flatten; }
  const edit = head.snapshot(document);
  head.commit({ expect: head.checkpoint(), origin: { kind: "external-transition" },
    edits: [{ document, range: edit.rangeUtf16(0, 1), text: "b" }] });
  edit.dispose();
  expect(source.isCurrent(snapshot)).toBe(false);
  expect(snapshot.readUtf16(0, 1)).toBe("a");
  const current = source.snapshot();
  expect(current.readUtf16(0, 1)).toBe("b"); current.dispose();
  snapshot.dispose(); source.dispose(); head.dispose(); writer.dispose(); store.dispose();
});

test("product fast/full source replacement neither reinterprets old offsets nor disposes either data owner", () => {
  const buffer = new GapBuffer("fast"), fast = buffer.source(), read = fast.snapshot();
  const store = new NativeStore({ random: { fill(bytes) { bytes.fill(1); } } });
  const document = documentId("full");
  const initial = store.createDocument({ id: document, base: { id: externalBaseId("explicit-transition"), text: "full" } });
  const writer = store.openWriter({ actor: actorId("actor"), replica: replicaId("replica") });
  const head = store.fork({ at: store.revisions([initial]), writer });
  const full = textSourceFromHead(head, document), current = full.snapshot();
  expect(full.isCurrent(read)).toBe(false);
  expect(() => current.read(read.rangeUtf16(0, 1))).toThrow("WRONG_TEXT_VIEW");
  expect(read.readUtf16(0, 4)).toBe("fast");
  expect(current.readUtf16(0, 4)).toBe("full");
  read.dispose(); fast.dispose(); current.dispose(); full.dispose();
  buffer.insert(0, "still-owned:");
  const stillAlive = head.snapshot(document);
  expect(stillAlive.readUtf16(0, 4)).toBe("full"); stillAlive.dispose();
  head.dispose(); writer.dispose(); store.dispose();
});
