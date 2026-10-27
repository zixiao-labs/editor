import type { CancellationSignal, EditorSession, DiffReport, DocumentId } from "@zixiao-labs/editor";
import type { SyntaxService } from "@zixiao-labs/editor/languages";
import type { LayoutEngine } from "@zixiao-labs/editor/shaping";
import type { VgpuFactories } from "@zixiao-labs/editor/vgpu";
import type { BrowserFactories } from "@zixiao-labs/editor/browser";

declare const gpu: VgpuFactories;
declare const browser: BrowserFactories;
declare const session: EditorSession;
declare const layout: LayoutEngine;
declare const syntax: SyntaxService;
declare const report: DiffReport;
declare const document: DocumentId;
declare const canvas: HTMLCanvasElement;
declare const inputElement: HTMLTextAreaElement;
const signal: CancellationSignal = new AbortController().signal;

async function attach(): Promise<void> {
  const view = await gpu.mountVgpuView({ session, element: canvas, layout });
  const input = browser.bindBrowserInput({ session, element: inputElement, geometry: view });
  input.dispose();
  view.dispose();
  const diff = await gpu.mountVgpuDiffView({ report, document, element: canvas, layout, syntax });
  diff.onActivate(hit => {
    const side: "before" | "after" = hit.side;
    void [side, hit.revision, hit.point];
  });
  diff.dispose();
}
// @ts-expect-error Mounting is a contract, not a runtime export.
import { mountVgpuView } from "@zixiao-labs/editor/vgpu";
// @ts-expect-error Input binding is a contract, not a runtime export.
import { bindBrowserInput } from "@zixiao-labs/editor/browser";
void [signal, attach, mountVgpuView, bindBrowserInput];
