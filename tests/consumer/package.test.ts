import { expect, test } from "@lightning-js/lightning";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

test("built package imports by public name without DOM/GPU/parser/network dependencies", async () => {
  const name = "@zixiao-labs/editor";
  const core = await import(name);
  expect(core.documentId("consumer")).toBe("consumer");
  expect(new core.EditorError("UNKNOWN_DOCUMENT", "missing").code).toBe("UNKNOWN_DOCUMENT");
});

test("native Node ESM import never touches DOM or the network", () => {
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    for (const key of ["document", "window", "navigator"]) {
      Object.defineProperty(globalThis, key, { get() { throw new Error("unexpected DOM access: " + key); } });
    }
    globalThis.fetch = () => { throw new Error("unexpected network access"); };
    const api = await import("@zixiao-labs/editor");
    if (api.documentId("node-smoke") !== "node-smoke") throw new Error("bad export");
    if ("createHistoryStore" in api) throw new Error("unimplemented core factory");
    const backend = api.defineHistoryBackend({
      descriptor: {
        id: api.historyBackendId("consumer:custom"), contractVersion: 1, algorithm: "product/v1",
        formats: { history: "product-history/v1", position: "product-position/v1" },
        capabilities: { selectiveUndo: false, deferredImport: false },
      },
      createStore() { throw new Error("product-factory-reached"); },
    });
    let routed = false;
    try { backend.createStore(); } catch (error) { routed = error.message === "product-factory-reached"; }
    if (!routed) throw new Error("backend factory was not invoked");
    const source = api.createTextSource({
      snapshot() {
        return { kind: "snapshot", lengthUtf16: 4, readUtf16: (a, b) => "A😀B".slice(a, b), dispose() {} };
      },
      onChange() { return { dispose() {} }; },
    });
    const read = source.snapshot();
    if (read.readUtf16(1, 3) !== "😀") throw new Error("bounded read failed");
    let boundary = false;
    try { read.pointUtf16(2); } catch (error) { boundary = error.code === "INVALID_BOUNDARY"; }
    if (!boundary) throw new Error("scalar boundary was not checked");
    read.dispose(); source.dispose();
    for (const entry of ["collaboration", "languages", "lsp", "shaping", "vgpu", "browser"]) {
      const contracts = await import("@zixiao-labs/editor/" + entry);
      if (Object.keys(contracts).length) throw new Error("unexpected runtime export: " + entry);
    }
    process.stdout.write("headless-ok");
  `], { encoding: "utf8" });
  expect(output).toBe("headless-ok");
});

test("the root ESM stays within its documented 128 KiB gzip budget", () => {
  const code = readFileSync(new URL("../../dist/index.js", import.meta.url));
  expect(gzipSync(code).length).toBeLessThanOrEqual(128 * 1024);
});

test("every declared public entry has built ESM and declarations with no undeclared exports", () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  expect(Object.keys(manifest.exports).sort()).toEqual([
    ".", "./browser", "./collaboration", "./languages", "./lsp", "./shaping", "./vgpu",
  ]);
  const entries = Object.values(manifest.exports) as { types: string; import: string }[];
  const dependencies = JSON.parse(execFileSync(process.execPath, [
    "--experimental-vm-modules", "--input-type=module", "-e", `
      import { SourceTextModule } from "node:vm";
      import { readFileSync } from "node:fs";
      if (new SourceTextModule('import "dependency-negative-control"').dependencySpecifiers.length !== 1)
        throw new Error("module parser did not detect the negative control");
      process.stdout.write(JSON.stringify(process.argv.slice(1).map(path =>
        new SourceTextModule(readFileSync(path, "utf8")).dependencySpecifiers)));
    `, ...entries.map((entry) => fileURLToPath(new URL(entry.import, root))),
  ], { encoding: "utf8" })) as string[][];
  expect(dependencies).toEqual(entries.map(() => []));
  for (const entry of entries) {
    expect(readFileSync(new URL(entry.types, root), "utf8").length).toBeGreaterThan(0);
    const code = readFileSync(new URL(entry.import, root), "utf8");
    // Parse static dependencies instead of mistaking error strings ending in
    // "import" for syntax. Dynamic loading remains prohibited in these entries.
    expect(/\b(?:import|require)\s*\(/u.test(code)).toBe(false);
    if (entry.import === "./dist/index.js") expect(/FugueSequence|NativeStore|TextRope|SumTree/u.test(code)).toBe(false);
  }
});
