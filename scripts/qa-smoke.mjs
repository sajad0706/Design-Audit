import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const tempDir = await mkdtemp(path.join(tmpdir(), "design-audit-qa-"));
const outfile = path.join(tempDir, "qa-module.mjs");

try {
  await build({
    bundle: true,
    entryPoints: [path.join(root, "scripts/qa-smoke.ts")],
    format: "esm",
    logLevel: "silent",
    outfile,
    platform: "node"
  });

  const { runQaSmoke } = await import(pathToFileURL(outfile).href);
  await runQaSmoke();
} finally {
  await rm(tempDir, { force: true, recursive: true });
}
