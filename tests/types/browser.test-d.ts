import { expectTypeOf } from "@lightning-js/lightning";
import type { CancellationSignal, DiffReport, EditorSession, TextSnapshot, TextSource } from "../../src/index.js";
import type { SyntaxService } from "../../src/languages.js";
import type { LayoutEngine, VisualPoint } from "../../src/shaping.js";
import type { VgpuFactories, VgpuEditorView } from "../../src/vgpu.js";
import type { BrowserFactories } from "../../src/browser.js";

declare const gpu: VgpuFactories;
declare const browser: BrowserFactories;
declare const session: EditorSession;
declare const canvas: HTMLCanvasElement;
declare const element: HTMLTextAreaElement;
declare const layout: LayoutEngine;
declare const syntax: SyntaxService;
declare const report: DiffReport;
declare const source: TextSnapshot;
declare const visual: VisualPoint;
declare const view: VgpuEditorView;
declare const externalText: TextSource;

// Native browser cancellation remains structurally compatible with the ES-only core.
expectTypeOf<AbortSignal>().toExtend<CancellationSignal>();

async function mountWorkflow(): Promise<void> {
  const readonly = await gpu.mountVgpuTextView({ source: externalText, element: canvas, layout });
  readonly.setSource(externalText);
  // @ts-expect-error A render-only view is not an editable session geometry provider.
  browser.bindBrowserInput({ session, element, geometry: readonly });
  readonly.dispose();
  const view = await gpu.mountVgpuView({ session, element: canvas, layout });
  const input = browser.bindBrowserInput({ session, element, geometry: view });
  const states = view.onStateChange(state => {
    if (state.kind === "device-lost") expectTypeOf(state.cause.code).toEqualTypeOf<
      import("../../src/index.js").EditorErrorCode
    >();
  });
  view.resize({ widthCssPx: 800, heightCssPx: 600, devicePixelRatio: 2 });
  await view.recover();
  input.onComposition(event => {
    if (event.kind === "cancelled") expectTypeOf(event.recoverableText).toEqualTypeOf<string>();
  });
  input.dispose();
  states.dispose();
  view.dispose();
  session.checkpoint(); // Detaching does not transfer ownership of the model.
  const diff = await gpu.mountVgpuDiffView({
    report, document: source.document, element: canvas, layout, syntax,
    options: { lineNumbers: false, maxVisibleRows: 12 },
  });
  const hit = diff.hitTest(visual);
  if (hit) {
    expectTypeOf(hit.side).toEqualTypeOf<"before" | "after">();
    expectTypeOf(hit.revision).toEqualTypeOf<typeof source.revision>();
  }
  diff.dispose();
}

// @ts-expect-error A source point cannot be used as layout-generation-bound geometry.
view.hitTest(source.pointUtf16(0));
// @ts-expect-error The read-only Diff view does not take a writable session in place of a report.
gpu.mountVgpuDiffView({ session, document: source.document, element: canvas, layout });
// @ts-expect-error Browser input needs an editor geometry provider, not a source snapshot.
browser.bindBrowserInput({ session, element, geometry: source });
// @ts-expect-error Type-only entries do not export executable mount functions yet.
import { mountVgpuView } from "../../src/vgpu.js";
void [mountWorkflow, mountVgpuView];
