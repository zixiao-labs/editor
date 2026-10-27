import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const measurements = [];
for (const [entry, paths] of Object.entries(manifest.exports)) {
  const code = readFileSync(resolve(root, paths.import));
  const seen = new Set();
  const visit = file => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/gu)) {
      visit(resolve(dirname(file), match[1].replace(/\.js$/u, ".d.ts")));
    }
  };
  visit(resolve(root, paths.types));
  const declarations = [...seen].map(file => readFileSync(file));
  measurements.push({
    entry,
    jsBytes: code.length,
    jsGzipBytes: gzipSync(code).length,
    declarationClosureBytes: declarations.reduce((n, bytes) => n + bytes.length, 0),
    declarationClosureGzipBytes: declarations.reduce((n, bytes) => n + gzipSync(bytes).length, 0),
  });
}
console.log(JSON.stringify(measurements, null, 2));
