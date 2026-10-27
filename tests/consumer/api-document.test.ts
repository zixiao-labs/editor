import { expect, test } from "@lightning-js/lightning";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Check the actual locked document, not a second manually maintained copy of its signatures.
const supplemental = {
  Core: [
    "Disposable", "DocumentId", "RevisionId", "HeadId", "HeadStamp", "ExcerptId", "JsonValue",
    "TextRange", "StablePosition", "StableRange", "HistoryStoreOptions", "ExternalBaseId",
    "ActorId", "ReplicaId", "Writer", "RetentionHandle", "ExportedPosition", "PositionToken",
    "HistoryBundle", "HistoryImportReport", "DiffReport", "DocumentTarget", "SourceEdit",
    "EditOrigin", "CommitReceipt", "HeadChangeEvent", "RevisionInfo", "TransactionId",
    "TransactionInfo", "HistoryCursor", "HistoryPage", "ProvenanceSpan", "PositionResolution",
    "SelectionId", "SelectionVersion", "SavedSelections", "SelectionRestoreResult",
    "SelectionChangeEvent", "EditorSession", "MultiBuffer", "CancellationSignal",
    "ExcerptSpec", "ProjectionDecoration",
  ],
  Collaboration: [
    "HistorySyncPort", "HistorySyncOffer", "HistoryOfferDescriptor", "PeerKnowledge",
    "HistoryReceiveEvent",
  ],
  Lsp: ["JsonRpcMessage", "LspInitializationOptions", "LanguageClient"],
  Shaping: ["LayoutEngine"],
  Languages: ["DiffSyntaxProvider"],
  Vgpu: ["VgpuDiffView", "VgpuEditorView"],
} as const;
const modules = {
  Core: "index", Collaboration: "collaboration", Lsp: "lsp",
  Shaping: "shaping", Languages: "languages", Vgpu: "vgpu",
} as const;
const factories = {
  createHistoryStore: "Core.CoreFactories",
  createEditorSession: "Core.CoreFactories",
  createMultiBuffer: "Core.CoreFactories",
  formatUnifiedDiff: "Core.CoreFactories",
  createHistorySyncPort: "Collaboration.CollaborationFactories",
  connectLanguageServer: "Lsp.LspFactories",
  mountVgpuView: "Vgpu.VgpuFactories",
  mountVgpuDiffView: "Vgpu.VgpuFactories",
} as const;

function fixture(code: string, dom: boolean): string {
  const declarations = new Set(
    [...code.matchAll(/\b(?:interface|type|function)\s+(\w+)/gu)].map(match => match[1]!),
  );
  const prelude: string[] = [];
  for (const namespace of Object.keys(modules) as (keyof typeof modules)[]) {
    if (!dom && namespace === "Vgpu") continue;
    const path = fileURLToPath(new URL(`../../src/${modules[namespace]}.js`, import.meta.url))
      .replaceAll("\\", "/");
    prelude.push(`import type * as ${namespace} from ${JSON.stringify(path)};`);
    for (const name of supplemental[namespace]) {
      if (!declarations.has(name)) prelude.push(`type ${name} = ${namespace}.${name};`);
    }
  }
  const checks: string[] = [];
  for (const [name, owner] of Object.entries(factories)) {
    if (!declarations.has(name)) continue;
    checks.push(
      `declare const actual_${name}: ${owner}[${JSON.stringify(name)}];`,
      `const forward_${name}: typeof ${name} = actual_${name};`,
      `const reverse_${name}: typeof actual_${name} = ${name};`,
    );
  }
  // A documented interface must also fit the shipped one in both directions.
  for (const name of declarations) {
    const owner = ["RpcTransport"].includes(name) ? "Lsp" :
      ["HistorySyncPort", "HistorySyncOffer"].includes(name) ? "Collaboration" : "Core";
    if (name in factories) continue;
    checks.push(
      `declare const actual_${name}: ${owner}.${name};`,
      `const forward_${name}: ${name} = actual_${name};`,
      `const reverse_${name}: typeof actual_${name} = forward_${name};`,
    );
  }
  return `${prelude.join("\n")}\n${code}\n${checks.join("\n")}\n`;
}

test("locked API code blocks compile and agree with public contracts, with a negative control", () => {
  const markdown = readFileSync(new URL("../../docs/editor-api.md", import.meta.url), "utf8");
  const blocks = [...markdown.matchAll(/```ts\n([\s\S]*?)```/gu)].map(match => match[1]!);
  expect(blocks.length).toBeGreaterThan(0);
  const headless = blocks.filter(code => !code.includes("HTMLCanvasElement")).join("\n");
  const browser = blocks.filter(code => code.includes("HTMLCanvasElement")).join("\n");
  expect(browser.length).toBeGreaterThan(0);
  const directory = mkdtempSync(join(tmpdir(), "editor-api-contract-"));
  try {
    const compile = (name: string, code: string, dom: boolean) => {
      const source = join(directory, `${name}.mts`);
      const config = join(directory, `${name}.json`);
      writeFileSync(source, fixture(code, dom));
      writeFileSync(config, JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
          lib: dom ? ["ES2022", "DOM"] : ["ES2022"], types: [],
          strict: true, exactOptionalPropertyTypes: true, skipLibCheck: false, noEmit: true,
        },
        files: [source],
      }));
      const result = spawnSync("pnpm", ["exec", "tsc", "--project", config], {
        encoding: "utf8", timeout: 20_000,
      });
      if (result.error) throw result.error;
      return result;
    };
    for (const [name, code, dom] of [
      ["headless", headless, false], ["browser", browser, true],
    ] as const) {
      const result = compile(name, code, dom);
      if (result.status !== 0) throw new Error(`${name} document contract:\n${result.stdout}${result.stderr}`);
    }
    const broken = headless.replace("pointUtf16(offset: number)", "pointUtf16(offset: string)");
    expect(broken).not.toBe(headless);
    const rejected = compile("negative-control", broken, false);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout).toContain("pointUtf16");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
