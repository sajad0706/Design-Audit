import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const dist = path.join(root, "dist");

await mkdir(dist, { recursive: true });

await build({
  bundle: true,
  define: { "process.env.NODE_ENV": "\"production\"" },
  entryPoints: ["src/plugin/controller.ts"],
  minify: true,
  outfile: "code.js",
  format: "iife",
  platform: "browser",
  target: "es2017",
  supported: { "template-literal": false },
  sourcemap: false
});

await build({
  bundle: true,
  define: { "process.env.NODE_ENV": "\"production\"" },
  entryPoints: ["src/ui/index.tsx"],
  minify: true,
  outdir: "dist",
  format: "iife",
  platform: "browser",
  target: "es2017",
  sourcemap: false
});

const htmlTemplate = await readFile(path.join(root, "src/ui/index.html"), "utf8");
const js = await readFile(path.join(dist, "index.js"), "utf8");
let css = "";

try {
  css = await readFile(path.join(dist, "index.css"), "utf8");
} catch {
  css = "";
}

const html = htmlTemplate
  .replace("<!-- INLINE_CSS -->", `<style>${css}</style>`)
  .replace("<!-- INLINE_JS -->", `<script>${js}</script>`);

await writeFile(path.join(root, "ui.html"), html);
