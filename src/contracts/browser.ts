import type { Disposable, EditorSession, SourceEndpoint } from "./core.js";
import type { EditorError } from "../errors.js";
import type { EditorGeometry } from "./shaping.js";

export type BrowserCompositionEvent =
  | Readonly<{ kind: "started" | "updated"; target: SourceEndpoint; text: string }>
  | Readonly<{ kind: "committed"; text: string }>
  | Readonly<{ kind: "cancelled"; cause: EditorError; recoverableText: string }>;
export interface BrowserInputBinding extends Disposable {
  focus(): void;
  onComposition(listener: (event: BrowserCompositionEvent) => void): Disposable;
}
export interface BrowserFactories {
  bindBrowserInput(input: {
    session: EditorSession; element: HTMLElement; geometry: EditorGeometry;
  }): BrowserInputBinding;
}
