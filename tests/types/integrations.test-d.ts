import { expectTypeOf } from "@lightning-js/lightning";
import type {
  CancellationSignal, EditingHead, HeadCheckpoint, ProjectionPoint, TextPoint, TextSnapshot, TextReadSnapshot,
} from "../../src/index.js";
import type { CollaborationFactories } from "../../src/collaboration.js";
import type {
  LanguageFactories, SyntaxClassification, SyntaxPlugin, SyntaxService,
} from "../../src/languages.js";
import type {
  LspFactories, RpcTransport, LanguageBinding, DiagnosticsEvent, LspRequestResult, Hover,
  JsonRpcMessage, LspStamp, LspWorkspaceEdit,
} from "../../src/lsp.js";
import type {
  ShapingFactories, Shaper, LoadedFont, VisualPoint, GlyphCluster, LayoutGeneration,
} from "../../src/shaping.js";

declare const languagesApi: LanguageFactories;
declare const lspApi: LspFactories;
declare const shaping: ShapingFactories;
declare const head: EditingHead;
declare const source: TextSnapshot;
declare const external: TextReadSnapshot;
declare const transport: RpcTransport;
declare const shaper: Shaper;
declare const fallback: readonly LoadedFont[];
declare const bytes: Uint8Array;
declare const signal: CancellationSignal;
declare const syntax: SyntaxService;
declare const plugin: SyntaxPlugin;
declare const binding: LanguageBinding;
declare const checkpoint: HeadCheckpoint;
declare const projected: ProjectionPoint;
declare const visual: VisualPoint;
declare const cluster: GlyphCluster;
declare const generation: LayoutGeneration;
declare const diagnostics: DiagnosticsEvent;
declare const stamps: readonly LspStamp[];
declare const workspaceEdit: LspWorkspaceEdit;

const registry = languagesApi.createLanguageRegistry();
const registration = registry.register({ id: "typescript", syntax: plugin });
const service = languagesApi.attachSyntax({ head, languages: registry });
service.setLanguage({ document: source.document, language: "typescript" });
const tokens = service.classify({ document: source.document, revision: source.revision, signal });
expectTypeOf(tokens).toEqualTypeOf<Promise<SyntaxClassification>>();
expectTypeOf<CollaborationFactories>().not.toEqualTypeOf<LanguageFactories>();
expectTypeOf<SyntaxClassification["grammarGeneration"]>().not.toEqualTypeOf<LayoutGeneration>();

async function languageWorkflow(): Promise<void> {
  const client = await lspApi.connectLanguageServer({
    transport,
    initialization: {
      rootUri: "file:///demo", workspaceFolders: [{ uri: "file:///demo", name: "demo" }],
    },
    unversionedDiagnostics: "report-only",
  });
  const document = client.bindDocument({
    head, document: source.document, uri: "file:///demo/main.ts", language: "typescript",
  });
  await document.sync({ at: source.revision });
  const hover = await document.hover({ at: source.revision, position: source.pointUtf16(0), signal });
  expectTypeOf(hover).toEqualTypeOf<LspRequestResult<Hover | null>>();
  if (hover.status === "ready" && hover.value) {
    expectTypeOf(hover.value.contents.value).toEqualTypeOf<string>();
  }
  if (hover.status === "stale") {
    // @ts-expect-error Stale responses cannot be consumed as ready values.
    void hover.value;
  }
  const completion = await document.completion({ at: source.revision, position: source.pointUtf16(0) });
  if (completion.status === "ready") {
    const proposal = completion.value.items[0]?.edit;
    if (proposal) head.commit({ ...proposal, origin: { kind: "lsp" } });
  }
  const proposal = client.prepareWorkspaceEdit({ head, edit: workspaceEdit, at: stamps });
  head.commit({ ...proposal, origin: { kind: "lsp" } });
  await document.definition({ at: source.revision, position: source.pointUtf16(0) });
  await document.semanticTokens({ at: source.revision });
  document.dispose();
  await client.shutdown();
}

async function shapingWorkflow(): Promise<void> {
  const plex = await shaping.loadFont({ bytes, expectedFamily: "IBM Plex Mono", signal });
  const layout = shaping.createLayoutEngine({
    shaper, fonts: { primary: plex, fallback }, features: { liga: true, calt: true },
  });
  layout.setOpenTypeFeatures({ liga: false, calt: false });
  const rendered = await layout.layoutText({
    source: external, viewport: { widthCssPx: 800, heightCssPx: 600, scrollXCssPx: 0, scrollYCssPx: 0 },
  });
  expectTypeOf(rendered.version).toEqualTypeOf<typeof external.version>();
  // @ts-expect-error A render-only point is not a causal/history edit point.
  const notHistory: TextPoint = external.pointUtf16(0);
  void notHistory;
  rendered.dispose();
  const frame = await layout.layout({
    source,
    viewport: { widthCssPx: 800, heightCssPx: 600, scrollXCssPx: 0, scrollYCssPx: 0 },
    signal,
  });
  frame.hitTest({ generation: frame.generation, xCssPx: 10, yCssPx: 20 });
  frame.dispose();
  layout.dispose();
  plex.dispose();
}

// @ts-expect-error Projected offsets cannot enter a source language-server request.
binding.hover({ at: source.revision, position: projected });
// @ts-expect-error Visual coordinates are not source points.
binding.completion({ at: source.revision, position: visual });
// @ts-expect-error Glyph cluster identities are not source points.
const point: TextPoint = cluster;
// @ts-expect-error A head CAS stamp is not a source revision.
binding.sync({ at: checkpoint.stamp });
// @ts-expect-error Grammar and layout generations have different domains.
const grammar: SyntaxClassification["grammarGeneration"] = generation;
// @ts-expect-error A JSON-RPC response cannot carry both success and failure.
const mixed: JsonRpcMessage = { jsonrpc: "2.0", id: 1, result: null, error: { code: 1, message: "bad" } };
// @ts-expect-error Protocol params must be an object or array.
transport.send({ jsonrpc: "2.0", method: "example", params: "not structured" });
// @ts-expect-error Resource operations are outside the supported WorkspaceEdit subset.
const resource: LspWorkspaceEdit = { documentChanges: [{ kind: "create", uri: "file:///new.ts" }] };
// @ts-expect-error Type contracts do not advertise runtime factories.
import { connectLanguageServer } from "../../src/lsp.js";
if (diagnostics.status === "unversioned") {
  // @ts-expect-error Unversioned diagnostics do not carry an invented source revision.
  void diagnostics.stamp.revision;
}
// @ts-expect-error Classification output is immutable.
syntax.classify({ document: source.document, revision: source.revision }).then(r => r.classifications.push({}));
void [languageWorkflow, shapingWorkflow, point, grammar, mixed, resource, registration, connectLanguageServer];
