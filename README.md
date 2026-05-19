# Design Audit

Figma plugin that audits the current selection or page against production code tokens and Figma design-lint rules, then writes short annotations directly on affected Figma layers.

## Core Checks

- Missing Figma styles for text, fills, strokes, and effects.
- Border radius values that do not match production radius tokens.
- Color, typography, spacing, radius, and effect values that drift from production tokens.
- Unlinked values that match a production token but are not using a Figma style or variable.
- Design lint without a production source: missing local styles, unbound matching variables, and off-scale radius values.
- Compact issue patterns in the panel so repeated layer issues are grouped instead of shown as a long flat list.

## Input Methods

- GitHub repository URL for public repositories.
- Repository upload as a ZIP file or extracted source folder.
- Direct HTML and CSS paste areas, kept separate so structure and styles are parsed together.
- Direct HTML, CSS, JS, TS, JSON, Vue, Svelte, SVG, or token file upload.

The source parser scans CSS custom properties, CSS declarations, JS/JSON token assignments, raw colors, spacing, typography, radius, and shadow values.

## Component Detection Flow

1. Select a Figma component or frame.
2. Add production source through HTML + CSS, files, repo upload, or GitHub.
3. Click `Load production component`.
4. Review the detected component preview and choose another candidate if the plugin finds more than one.
5. Click `Scan for mismatches`.

The plugin does not scan immediately after source loading. It first shows the production component name, source file, preview, and confidence so designers can confirm the right thing is being compared.

## Annotation Format

Each affected layer gets a simple message:

```text
❌ Color mismatch: Using #1a73e8.
✓ Expected: $color-primary-blue
```

The UI mirrors those annotations in a grouped results panel. Clicking an issue selects and zooms to the affected Figma layer.

## Files

- `src/plugin/controller.ts`: Figma plugin entrypoint and scan coordinator.
- `src/plugin/figmaScanner.ts`: Reads layers, styles, variables, paint, text, radius, and spacing values from Figma.
- `src/plugin/tokenMapper.ts`: Maps Figma values/styles/variables to production tokens.
- `src/plugin/lintRules.ts`: Produces user-facing issues and suggested fixes.
- `src/plugin/annotations.ts`: Clears and writes Figma annotations plus compact canvas labels.
- `src/ui/*`: React UI, source readers, and production token parser.
- `code.js` and `ui.html`: Generated Figma runtime files.

## Build

```bash
npm install
npm run check
npm run build
```

## Run In Figma

1. Open Figma desktop.
2. Go to `Plugins > Development > Import plugin from manifest...`.
3. Select `figma-production-compare/manifest.json`.
4. Run `Production Code Audit`.

The manifest includes a placeholder plugin ID. Replace it with the ID assigned by Figma before publishing.
