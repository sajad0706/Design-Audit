import { useEffect, useRef, useState } from "react";
import type {
  ControllerToUiMessage,
  ProductionReference,
  ScanReport,
  SelectedFigmaComponent,
  SourceInputKind,
  UiToControllerMessage
} from "../shared/types";
import { DetectedComponentPanel } from "./components/DetectedComponentPanel";
import { ResultsPanel } from "./components/ResultsPanel";
import { SelectedComponentPanel } from "./components/SelectedComponentPanel";
import { SourceInput } from "./components/SourceInput";
import { Tooltip } from "./components/Tooltip";
import { readGithubRepository, readProductionFiles, readRepositoryUpload } from "./sourceReaders";

export function App() {
  const [mode, setMode] = useState<SourceInputKind>("html-css");
  const [repoUrl, setRepoUrl] = useState("");
  const [htmlCode, setHtmlCode] = useState("");
  const [cssCode, setCssCode] = useState("");
  const [includeDesignLint, setIncludeDesignLint] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [status, setStatus] = useState("Select a Figma component, then load production code.");
  const [reference, setReference] = useState<ProductionReference | null>(null);
  const [selectedComponentId, setSelectedComponentId] = useState("");
  const [selectedFigmaComponent, setSelectedFigmaComponent] = useState<SelectedFigmaComponent | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);

  const githubInputRef = useRef<HTMLInputElement>(null);
  const repoZipRef = useRef<HTMLInputElement>(null);
  const repoFolderRef = useRef<HTMLInputElement>(null);
  const productionFilesRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.onmessage = (event: MessageEvent<{ pluginMessage?: ControllerToUiMessage }>) => {
      const message = event.data.pluginMessage;
      if (!message) return;
      if (message.type === "progress") setStatus(message.message);
      if (message.type === "scan-complete") {
        setBusy(false);
        setReport(message.report);
        setStatus(message.report.issues.length ? "Scan complete. Review grouped issues below." : "Scan complete. No mismatches found.");
      }
      if (message.type === "annotations-cleared") {
        setBusy(false);
        setStatus("Annotations cleared.");
      }
      if (message.type === "selection-info") {
        setSelectedFigmaComponent(message.component);
      }
      if (message.type === "error") {
        setBusy(false);
        setStatus(message.message);
      }
    };
    post({ type: "inspect-selection" });
    return () => {
      window.onmessage = null;
    };
  }, []);

  async function loadProductionSource() {
    try {
      setLoadingSource(true);
      setReport(null);
      setStatus("Detecting the production component...");
      const nextReference = await readReference();
      const first = nextReference.components[0];
      setReference(nextReference);
      setSelectedComponentId(first?.id || "");
      setStatus(first
        ? `${first.name} detected. Review the preview, then scan for mismatches.`
        : "We couldn’t confidently detect the production component.");
    } catch (error) {
      setReference(null);
      setSelectedComponentId("");
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingSource(false);
    }
  }

  async function scan() {
    try {
      if (!selectedFigmaComponent?.hasSelection) throw new Error("Select a Figma component before scanning.");
      const scanReference = selectedProductionReference();
      if (hasSourceInput() && !scanReference) throw new Error("Load and confirm a production component before scanning.");
      if (!scanReference) throw new Error("Load and confirm a production component before scanning.");
      setBusy(true);
      setStatus(scanReference ? "Comparing the selected design with production..." : "Running design lint...");
      post({ type: "scan", reference: scanReference, annotate: true, includeDesignLint });
    } catch (error) {
      setBusy(false);
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  async function readReference(): Promise<ProductionReference> {
    if (!hasSourceInput()) throw new Error("Connect a production source first.");

    if (mode === "github") return readGithubRepository(repoUrl);
    if (mode === "repo-upload") return readRepositoryUpload(repoZipRef.current?.files?.[0] || null, repoFolderRef.current?.files || null);
    if (mode === "production-file") return readProductionFiles(productionFilesRef.current?.files || null);
    return readProductionFiles(null, htmlCode, cssCode, "html-css");
  }

  function hasSourceInput(): boolean {
    if (mode === "github") return repoUrl.trim().length > 0;
    if (mode === "repo-upload") return Boolean(repoZipRef.current?.files?.length || repoFolderRef.current?.files?.length);
    if (mode === "production-file") return Boolean(productionFilesRef.current?.files?.length);
    return Boolean(htmlCode.trim().length || cssCode.trim().length);
  }

  function selectedProductionReference(): ProductionReference | null {
    if (!reference) return null;
    const selected = reference.components.find((component) => component.id === selectedComponentId);
    if (!selected) return null;
    const tokenIds = new Set(selected.tokenIds);
    const scopedTokens = tokenIds.size ? reference.tokens.filter((token) => tokenIds.has(token.id)) : reference.tokens;

    return {
      ...reference,
      label: selected.name,
      tokens: scopedTokens.length ? scopedTokens : reference.tokens,
      selectedComponentId: selected.id
    };
  }

  function resetDetectedSource() {
    setReference(null);
    setSelectedComponentId("");
    setReport(null);
    setStatus("Production source changed. Load it to detect the component.");
  }

  function changeMode(nextMode: SourceInputKind) {
    setMode(nextMode);
    resetDetectedSource();
  }

  function clearAnnotations() {
    setBusy(true);
    post({ type: "clear-annotations" });
  }

  function selectNode(nodeId: string) {
    post({ type: "select-node", nodeId });
  }

  const selectedProduction = reference?.components.find((component) => component.id === selectedComponentId) || null;
  const canScanProduction = Boolean(selectedFigmaComponent?.hasSelection && selectedProduction);
  const scanDisabled = busy || loadingSource || !canScanProduction;

  return (
    <main>
      <header className="app-header">
        <div>
          <h1>Design Audit</h1>
          <p>{status}</p>
        </div>
        <Tooltip label="Fix all issues before developer handoff" />
      </header>

      <SelectedComponentPanel component={selectedFigmaComponent} />

      <SourceInput
        mode={mode}
        repoUrl={repoUrl}
        htmlCode={htmlCode}
        cssCode={cssCode}
        onModeChange={changeMode}
        onRepoUrlChange={(value) => {
          setRepoUrl(value);
          resetDetectedSource();
        }}
        onHtmlCodeChange={(value) => {
          setHtmlCode(value);
          resetDetectedSource();
        }}
        onCssCodeChange={(value) => {
          setCssCode(value);
          resetDetectedSource();
        }}
        onFilesChange={resetDetectedSource}
        githubInputRef={githubInputRef}
        repoZipRef={repoZipRef}
        repoFolderRef={repoFolderRef}
        productionFilesRef={productionFilesRef}
      />

      <section className="actions load-actions">
        <button className="secondary" disabled={busy || loadingSource || !hasSourceInput()} onClick={loadProductionSource} type="button">
          {loadingSource ? "Detecting..." : "Load production component"}
        </button>
      </section>

      <DetectedComponentPanel
        reference={reference}
        selectedId={selectedComponentId}
        loading={loadingSource}
        onSelect={setSelectedComponentId}
      />

      <section className="panel scan-panel">
        <div className="panel-title">
          <h2>Scan</h2>
          <span className={selectedProduction ? "status-pill ready" : "status-pill"}>{selectedProduction ? "Confirmed" : "Waiting"}</span>
        </div>

        <label className="check-row">
          <input type="checkbox" checked={includeDesignLint} onChange={(event) => setIncludeDesignLint(event.target.checked)} />
          <span>Design lint</span>
        </label>

        <div className="actions">
          <button className="primary" disabled={scanDisabled} onClick={scan} type="button">
            {busy ? "Scanning..." : "Scan for mismatches"}
          </button>
          <button disabled={busy || loadingSource} onClick={clearAnnotations} type="button">
            Clear
          </button>
        </div>

        <p className="muted">
          {selectedProduction
            ? `Scanning will compare against ${selectedProduction.name}.`
            : "Load and confirm a production component before scanning."}
        </p>
      </section>

      <ResultsPanel report={report} onSelectNode={selectNode} />
    </main>
  );
}

function post(message: UiToControllerMessage) {
  parent.postMessage({ pluginMessage: message }, "*");
}
