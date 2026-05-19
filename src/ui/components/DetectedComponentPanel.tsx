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
  const selectedScore = displayScore(selected);

  return (
    <section className="panel detected-panel">
      <div className="panel-title">
        <h2>Detected Production Component</h2>
        <Tooltip label="Confirm the detected component before scanning" />
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
          {!selectedId && (
            <div className="notice-box">
              <strong>Please confirm the production component.</strong>
              <span>Choose the preview that matches the selected Figma component before scanning.</span>
            </div>
          )}

          <div className="detected-header">
            <div>
              <strong>{selected.name}</strong>
              <span>{selected.sourceFile || selected.sourceLabel}</span>
            </div>
            <span className={`confidence ${confidenceClass(selectedScore)}`}>{selectedScore}% match</span>
          </div>

          <CandidateSignals candidate={selected} />

          {(candidates.length > 1 || !selectedId) && (
            <div className="candidate-list" aria-label="Possible production components">
              {candidates.map((candidate) => (
                <button
                  className={[
                    "candidate-button",
                    candidate.id === selectedId ? "active" : "",
                    !selectedId && candidate.id === selected.id ? "previewing" : ""
                  ].filter(Boolean).join(" ")}
                  key={candidate.id}
                  onClick={() => onSelect(candidate.id)}
                  type="button"
                >
                  <strong>{candidate.name}</strong>
                  <span>{displayScore(candidate)}%</span>
                  <small>{candidate.matchReasons?.slice(0, 2).join(" · ") || candidate.summary}</small>
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

function CandidateSignals({ candidate }: { candidate: ProductionComponentCandidate }) {
  const reasons = candidate.matchReasons || [];
  const warnings = candidate.matchWarnings || [];
  if (!reasons.length && !warnings.length) return null;

  return (
    <div className="candidate-signals">
      {reasons.map((reason) => (
        <span className="signal-good" key={reason}>{reason}</span>
      ))}
      {warnings.map((warning) => (
        <span className="signal-warning" key={warning}>{warning}</span>
      ))}
    </div>
  );
}

function displayScore(candidate: ProductionComponentCandidate | null): number {
  return candidate ? candidate.matchScore ?? candidate.confidence : 0;
}

function previewDocument(candidate: ProductionComponentCandidate): string {
  const css = candidate.css.replace(/<\/style/gi, "<\\/style");
  const html = candidate.html.replace(/<\/script/gi, "<\\/script");
  const dir = /dir\s*=\s*["']rtl["']|[\u0600-\u06FF]/i.test(candidate.html) ? "rtl" : "ltr";
  return `<!doctype html>
<html dir="${dir}">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;" />
  <style>
    html, body {
      margin: 0;
      min-height: 100%;
      direction: ${dir};
      background: transparent;
      color: #1f1f23;
      font-family: Vazirmatn, Tahoma, Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body {
      padding: 16px;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      overflow: auto;
    }
    * { box-sizing: border-box; }
    .__audit-preview-root {
      width: min(100%, 720px);
      max-width: 100%;
      display: block;
    }
    .__audit-preview-root > * {
      max-width: 100%;
    }
    svg {
      max-width: 100%;
      height: auto;
    }
    ${css}
  </style>
</head>
<body><div class="__audit-preview-root">${html}</div></body>
</html>`;
}

function confidenceClass(confidence: number): string {
  if (confidence >= 76) return "high";
  if (confidence >= 55) return "medium";
  return "low";
}
