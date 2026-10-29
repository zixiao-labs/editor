import type {
  Affinity, CancellationSignal, Disposable, ProjectionSnapshot, SourceEndpoint, TextPoint,
  TextRange, TextSnapshot,
} from "./core.js";
import type { ExcerptId, Opaque } from "../identity.js";
import type { TextReadPoint, TextReadRange, TextReadSnapshot, TextReadVersion } from "./text-source.js";

export type FontId = Opaque<string, "FontId">;
export type GlyphId = Opaque<number, "GlyphId">;
export type GlyphCluster = Opaque<number, "GlyphCluster">;
export type LayoutGeneration = Opaque<number, "LayoutGeneration">;
export type OpenTypeFeatures = Readonly<Record<string, boolean | number>>;
export interface LoadedFont extends Disposable {
  readonly id: FontId;
  readonly family: string;
  readonly unitsPerEm: number;
}
export interface ShapedGlyph {
  readonly id: GlyphId;
  readonly cluster: GlyphCluster;
  readonly advanceXFontUnits: number;
  readonly advanceYFontUnits: number;
  readonly offsetXFontUnits: number;
  readonly offsetYFontUnits: number;
}
export interface ClusterMapping<Range = TextRange> {
  readonly cluster: GlyphCluster;
  readonly source: Range;
  readonly ligatureCaretsFontUnits: readonly number[];
}
export interface ShapedRun<Range = TextRange> {
  readonly font: FontId;
  readonly direction: "ltr" | "rtl";
  readonly glyphs: readonly ShapedGlyph[];
  readonly clusters: readonly ClusterMapping<Range>[];
}
export interface Shaper extends Disposable {
  shape(input: {
    source: TextSnapshot; range: TextRange; font: LoadedFont;
    direction: "ltr" | "rtl"; script: string; language: string;
    features: OpenTypeFeatures; signal?: CancellationSignal;
  }): Promise<ShapedRun>;
  shapeText(input: {
    source: TextReadSnapshot; range: TextReadRange; font: LoadedFont;
    direction: "ltr" | "rtl"; script: string; language: string;
    features: OpenTypeFeatures; signal?: CancellationSignal;
  }): Promise<ShapedRun<TextReadRange>>;
}
export interface LayoutViewport {
  readonly widthCssPx: number;
  readonly heightCssPx: number;
  readonly scrollXCssPx: number;
  readonly scrollYCssPx: number;
}
export interface VisualPoint {
  readonly generation: LayoutGeneration;
  readonly xCssPx: number;
  readonly yCssPx: number;
}
export interface VisualRect extends VisualPoint {
  readonly widthCssPx: number;
  readonly heightCssPx: number;
}
export interface LayoutHit {
  readonly point: TextPoint;
  readonly excerpt?: ExcerptId;
  readonly affinity: Affinity;
  readonly visual: VisualPoint;
}
export interface CaretStop extends LayoutHit {
  readonly method: "font" | "grapheme-interpolation" | "boundary";
}
export interface PositionedGlyph<Range = TextRange> {
  readonly glyph: GlyphId;
  readonly cluster: GlyphCluster;
  readonly font: FontId; // Actual fallback face, not the configured primary's name.
  readonly source: Range;
  readonly excerpt?: ExcerptId;
  readonly bounds: VisualRect;
}
// A source/excerpt request, never a naked current UTF-16 offset.
export interface EditorGeometry {
  readonly generation: LayoutGeneration;
  hitTest(point: VisualPoint): LayoutHit | null;
  caretRect(input: { endpoint: SourceEndpoint }): VisualRect | null;
}
export interface LayoutSnapshot extends Disposable, EditorGeometry {
  readonly viewport: LayoutViewport;
  readonly glyphs: readonly PositionedGlyph[];
  readonly caretStops: readonly CaretStop[];
  selectionGeometry(input: {
    anchor: SourceEndpoint; head: SourceEndpoint;
  }): readonly VisualRect[];
}
export interface TextReadLayoutHit {
  readonly point: TextReadPoint;
  readonly affinity: Affinity;
  readonly visual: VisualPoint;
}
export interface TextReadLayoutSnapshot extends Disposable {
  readonly version: TextReadVersion;
  readonly generation: LayoutGeneration;
  readonly viewport: LayoutViewport;
  readonly glyphs: readonly PositionedGlyph<TextReadRange>[];
  hitTest(point: VisualPoint): TextReadLayoutHit | null;
}
export interface LayoutEngine extends Disposable {
  readonly generation: LayoutGeneration;
  setOpenTypeFeatures(features: OpenTypeFeatures): void;
  onInvalidate(listener: (generation: LayoutGeneration) => void): Disposable;
  layout(input: {
    source: TextSnapshot | ProjectionSnapshot; viewport: LayoutViewport; signal?: CancellationSignal;
  }): Promise<LayoutSnapshot>;
  layoutText(input: {
    source: TextReadSnapshot; viewport: LayoutViewport; signal?: CancellationSignal;
  }): Promise<TextReadLayoutSnapshot>;
}
export interface ShapingFactories {
  loadFont(input: {
    bytes: Uint8Array; expectedFamily: string; signal?: CancellationSignal;
  }): Promise<LoadedFont>;
  createLayoutEngine(input: {
    shaper: Shaper; fonts: Readonly<{ primary: LoadedFont; fallback: readonly LoadedFont[] }>;
    features: OpenTypeFeatures;
  }): LayoutEngine;
}
