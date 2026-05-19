import type { SelectedFigmaComponent } from "../../shared/types";

interface SelectedComponentPanelProps {
  component: SelectedFigmaComponent | null;
}

export function SelectedComponentPanel({ component }: SelectedComponentPanelProps) {
  const selected = component?.hasSelection;

  return (
    <section className="panel selected-panel">
      <div className="panel-title">
        <h2>Selected Figma Component</h2>
        <span className={selected ? "status-pill ready" : "status-pill"}>{selected ? "Ready" : "Select one"}</span>
      </div>

      {component && selected ? (
        <div className="component-summary">
          <strong>{component.name}</strong>
          <span>{component.type}</span>
          <dl>
            <div>
              <dt>Size</dt>
              <dd>{component.width} x {component.height}</dd>
            </div>
            <div>
              <dt>Layers</dt>
              <dd>{component.childCount}</dd>
            </div>
            <div>
              <dt>Styles</dt>
              <dd>{component.styleSummary}</dd>
            </div>
            {component.textSample && (
              <div>
                <dt>Text</dt>
                <dd>{component.hasRtlText ? "Persian / RTL text detected" : "Text detected"}</dd>
              </div>
            )}
          </dl>
        </div>
      ) : (
        <p className="muted">Select the design component or frame you want to audit.</p>
      )}
    </section>
  );
}
