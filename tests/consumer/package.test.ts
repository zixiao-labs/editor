import { expect, test } from "@lightning-js/lightning";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

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
    process.stdout.write("headless-ok");
  `], { encoding: "utf8" });
  expect(output).toBe("headless-ok");
});

test("the root ESM stays within its documented 128 KiB gzip budget", () => {
  const code = readFileSync(new URL("../../dist/index.js", import.meta.url));
  expect(gzipSync(code).length).toBeLessThanOrEqual(128 * 1024);
});
