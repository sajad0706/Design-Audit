import type { ProductionComponentCandidate, ProductionReference } from "../../shared/types";
import { Tooltip } from "./Tooltip";

interface DetectedComponentPanelProps {
  reference: ProductionReference | null;
  selectedId: string;
  loading: boolean;
  onSelect: (id: string) => void;
}

export function DetectedComponentPanel({ reference, selectedId, loading, onSelect }: DetectedComponentPanelProps) {
  const candidates = reference?.components || [];
  const selected = candidates.find((candidate) => candidate.id === selectedId) || candidates[0] || null;

  return (
    <section className="panel detected-panel">
      <div className="panel-title">
        <h2>Detected Production Component</h2>
        <Tooltip label="Click any annotation to jump to the issue" />
      </div>

      {loading && <p className="muted">Detecting the production component...</p>}

      {!loading && !reference && (
        <p className="muted">Load production code to preview the component before scanning.</p>
      )}

      {!loading && reference && !candidates.length && (
        <div className="notice-box">
          <strong>We couldn’t confidently detect the production component.</strong>
          <span>Paste the component HTML and related CSS, or upload the exact component files.</span>
        </div>
      )}

      {!loading && selected && (
        <div className="detected-content">
          <div className="detected-header">
            <div>
              <strong>{selected.name}</strong>
              <span>{selected.sourceFile || selected.sourceLabel}</span>
            </div>
            <span className={`confidence ${confidenceClass(selected.confidence)}`}>{selected.confidence}% match</span>
          </div>

          {candidates.length > 1 && (
            <div className="candidate-list" aria-label="Possible production components">
              {candidates.map((candidate) => (
                <button
                  className={candidate.id === selected.id ? "candidate-button active" : "candidate-button"}
                  key={candidate.id}
                  onClick={() => onSelect(candidate.id)}
                  type="button"
                >
                  <strong>{candidate.name}</strong>
                  <span>{candidate.confidence}%</span>
                </button>
              ))}
            </div>
          )}

          <div className="preview-shell">
            <iframe sandbox="" title={`Preview of ${selected.name}`} srcDoc={previewDocument(selected)} />
          </div>

          <div className="candidate-meta">
            <span>{selected.summary}</span>
            <span>{selected.reason}</span>
          </div>
        </div>
      )}
    </section>
  );
}

function previewDocument(candidate: ProductionComponentCandidate): string {
  const css = candidate.css.replace(/<\/style/gi, "<\\/style");
  const html = candidate.html.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body {
      margin: 0;
      min-height: 100%;
      display: grid;
      place-items: center;
      background: transparent;
      color: #1f1f23;
      font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { padding: 16px; }
    * { box-sizing: border-box; }
    ${css}
  </style>
</head>
<body>${html}</body>
</html>`;
}

function confidenceClass(confidence: number): string {
  if (confidence >= 70) return "high";
  if (confidence >= 45) return "medium";
  return "low";
}
