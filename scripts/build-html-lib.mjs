/**
 * Build the standalone /html-lib widget bundles for html apps:
 *
 *   markdown.{js,css}   — window.CockpitMarkdown (MarkdownRenderer, see
 *                         packages/shared/ui/src/standalone/cockpitMarkdown.tsx)
 *   pdf-viewer.{js,css} — window.CockpitPdf (Explorer's FilePdfPreview, see
 *                         packages/feature/explorer/src/standalone/cockpitPdf.tsx)
 *
 * Each bundle is SELF-CONTAINED (own React copy; widgets expose imperative
 * APIs precisely so the host page's React version never matters). Per bundle:
 *   1. esbuild bundles the entry + any css it imports (katex fonts copied to
 *      public/html-lib/fonts/ with absolute /html-lib/ URLs).
 *   2. Tailwind v4 (postcss plugin) compiles just the utilities the widget
 *      uses (scripts/{md,pdf}-lib.css) and is appended to the css output.
 *
 * Wired into prebuild/predev; outputs are generated artifacts (gitignored) and
 * ship to npm via the `public` entry in package.json files.
 */
import { build } from "esbuild"
import postcss from "postcss"
import tailwindcss from "@tailwindcss/postcss"
import { readFile, writeFile, mkdir, access } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const outDir = path.join(root, "public", "html-lib")

const BUNDLES = [
  {
    name: "markdown",
    entry: "packages/shared/ui/src/standalone/cockpitMarkdown.tsx",
    twEntry: "scripts/md-lib.css",
  },
  {
    name: "pdf-viewer",
    entry: "packages/feature/explorer/src/standalone/cockpitPdf.tsx",
    twEntry: "scripts/pdf-lib.css",
  },
  {
    // Human-readable JSON view (Explorer "readable" toggle / tool-call
    // previews). Inline-styled renderer — no Tailwind stage needed.
    name: "json-viewer",
    entry: "packages/feature/explorer/src/standalone/cockpitJson.tsx",
    twEntry: null,
  },
]

await mkdir(outDir, { recursive: true })

for (const { name, entry, twEntry } of BUNDLES) {
  const outJs = path.join(outDir, `${name}.js`)
  const outCss = path.join(outDir, `${name}.css`)

  // Stage 1: JS bundle (+ any imported css / font assets)
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    minify: true,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    outfile: outJs,
    define: { "process.env.NODE_ENV": '"production"' },
    // Widgets own their microcopy: each entry inlines its default en/zh
    // strings and initializes the bundle-private i18next singleton itself.
    // Aliasing shared-i18n to bare `i18next` makes components that import the
    // app-wide dictionary module (e.g. toolCallUtils) resolve to that same
    // instance — the full ~84KB×2 global dict never enters a bundle.
    alias: { "@cockpit/shared-i18n": "i18next" },
    loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
    assetNames: "fonts/[name]-[hash]",
    // Fixed mount point: the lib is always served from /html-lib/
    publicPath: "/html-lib/",
    logLevel: "warning",
  })

  // Stage 2: Tailwind utilities for the widget, appended to the css output
  // (created first if the entry imported no css of its own). Skipped for
  // inline-styled widgets (twEntry: null).
  if (!twEntry) {
    console.log(`[build-html-lib] wrote html-lib/${name}.js (no css stage)`)
    continue
  }
  const twSource = await readFile(path.join(root, twEntry), "utf8")
  const twResult = await postcss([tailwindcss()]).process(twSource, {
    from: path.join(root, twEntry),
    map: false,
  })

  let esbuildCss = ""
  try {
    await access(outCss)
    esbuildCss = await readFile(outCss, "utf8")
  } catch {
    /* no css emitted by esbuild for this bundle */
  }
  await writeFile(
    outCss,
    `${esbuildCss}\n/* ---- Tailwind utilities (generated from ${twEntry}) ---- */\n${twResult.css}`,
  )

  console.log(`[build-html-lib] wrote html-lib/${name}.js + ${name}.css`)
}
