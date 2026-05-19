# Design Audit v1.0.0

Initial public release of the Figma production audit plugin.

## Highlights

- Audits a selected Figma component against production code tokens.
- Supports separated HTML and CSS input for component structure and styling.
- Supports production files, repository upload, and GitHub repository URLs.
- Detects the likely production component before scanning and shows a preview.
- Compares colors, typography, spacing, border radius, fills, strokes, effects, and token usage.
- Keeps design lint checks available during the scan.
- Adds concise Figma layer annotations with expected production values.
- Groups repeated issues in the results panel so designers can review patterns quickly.

## Validation

- `npm run check`
- `npm run build`
