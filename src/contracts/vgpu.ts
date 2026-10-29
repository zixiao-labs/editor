import type { DiffReport, Disposable, EditorSession, TextPoint } from "./core.js";
import type { DocumentId, RevisionId } from "../identity.js";
import type { EditorError } from "../errors.js";
import type { DiffSyntaxProvider } from "./languages.js";
import type { EditorGeometry, LayoutEngine, TextReadLayoutHit, LayoutGeneration, VisualPoint } from "./shaping.js";
import type { TextSource } from "./text-source.js";

export type VgpuViewState =
  | Readonly<{ kind: "loading-font" | "ready" | "disposed" }>
  | Readonly<{ kind: "webgpu-unavailable" | "device-lost"; cause: EditorError }>;
export interface VgpuView extends Disposable {
  state(): VgpuViewState;
  onStateChange(listener: (state: VgpuViewState) => void): Disposable;
  resize(input: { widthCssPx: number; heightCssPx: number; devicePixelRatio: number }): void;
  recover(): Promise<void>;
}
export interface VgpuEditorView extends VgpuView, EditorGeometry {}
export interface VgpuTextView extends VgpuView {
  readonly generation: LayoutGeneration;
  hitTest(point: VisualPoint): TextReadLayoutHit | null;
  /** Borrow the new source; do not destroy either product buffer/history owner. */
  setSource(source: TextSource): void;
}
export interface DiffViewHit {
  readonly document: DocumentId;
  readonly side: "before" | "after";
  readonly revision: RevisionId;
  readonly point: TextPoint;
}
export interface VgpuDiffView extends VgpuView {
  hitTest(point: VisualPoint): DiffViewHit | null;
  onActivate(listener: (hit: DiffViewHit) => void): Disposable;
}
export interface VgpuFactories {
  mountVgpuTextView(input: {
    source: TextSource; element: HTMLCanvasElement; layout: LayoutEngine;
  }): Promise<VgpuTextView>;
  mountVgpuView(input: {
    session: EditorSession; element: HTMLCanvasElement; layout: LayoutEngine;
  }): Promise<VgpuEditorView>;
  mountVgpuDiffView(input: {
    report: DiffReport; document: DocumentId; element: HTMLCanvasElement; layout: LayoutEngine;
    syntax?: DiffSyntaxProvider;
    options?: { lineNumbers?: boolean; maxVisibleRows?: number };
  }): Promise<VgpuDiffView>;
}
