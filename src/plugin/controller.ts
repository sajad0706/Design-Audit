import type { ControllerToUiMessage, ProductionReference, SelectedFigmaComponent, UiToControllerMessage } from "../shared/types";
import { annotateIssues, clearAuditAnnotations } from "./annotations";
import { collectDesignLintReference, type DesignLintReference } from "./designLint";
import { scanFigmaLayers } from "./figmaScanner";
import { lintScannedLayers } from "./lintRules";
import { createProductionTokenIndex } from "./tokenMapper";

declare const __html__: string;

figma.showUI(__html__, { width: 520, height: 760, themeColors: true });

let designLintReferenceCache: DesignLintReference | null = null;

figma.ui.onmessage = async (message: UiToControllerMessage) => {
  try {
    if (message.type === "scan") await runScan(message.reference, message.annotate, message.includeDesignLint);
    if (message.type === "inspect-selection") postSelectionInfo();
    if (message.type === "select-node") await selectNode(message.nodeId);
    if (message.type === "clear-annotations") {
      await clearAuditAnnotations();
      post({ type: "annotations-cleared" });
      figma.notify("Audit annotations cleared.");
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    post({ type: "error", message: text });
    figma.notify(text, { error: true });
  }
};

figma.on("selectionchange", postSelectionInfo);
postSelectionInfo();

// Coordinates source token indexing, Figma layer scanning, lint rules, and annotations.
async function runScan(reference: ProductionReference | null, annotate: boolean, includeDesignLint: boolean): Promise<void> {
  if (figma.currentPage.selection.length !== 1) {
    throw new Error(figma.currentPage.selection.length ? "Select one Figma component before scanning." : "Select a Figma component before scanning.");
  }

  const includeProduction = Boolean(reference?.tokens.length);
  const sourceLabel = reference?.label || "Design lint only";
  const index = includeProduction && reference ? createProductionTokenIndex(reference.tokens) : null;

  if (includeProduction) {
    post({ type: "progress", message: "Reading production tokens..." });
  }

  const designLintReference = includeDesignLint ? await readDesignLintReference() : null;

  post({ type: "progress", message: "Clearing previous audit annotations..." });
  await clearAuditAnnotations();

  post({ type: "progress", message: "Scanning Figma layers..." });
  const layers = await scanFigmaLayers();

  post({ type: "progress", message: includeProduction ? "Comparing design to code..." : "Running design lint..." });
  const report = lintScannedLayers(layers, index, sourceLabel, {
    includeProduction,
    includeDesignLint,
    designLintReference
  });

  if (annotate) {
    post({ type: "progress", message: "Adding layer annotations..." });
    await annotateIssues(report.issues, layers);
  }

  post({ type: "scan-complete", report });
  figma.notify(report.issues.length ? `${report.issues.length} audit issue${report.issues.length === 1 ? "" : "s"} found.` : "No audit issues found.");
}

async function readDesignLintReference() {
  if (designLintReferenceCache) return designLintReferenceCache;
  post({ type: "progress", message: "Reading Figma styles and variables..." });
  designLintReferenceCache = await collectDesignLintReference();
  return designLintReferenceCache;
}

async function selectNode(nodeId: string): Promise<void> {
  const node = figma.getNodeByIdAsync ? await figma.getNodeByIdAsync(nodeId) : figma.getNodeById(nodeId);
  if (!node || node.type === "PAGE" || node.type === "DOCUMENT") return;
  figma.currentPage.selection = [node as SceneNode];
  figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
  postSelectionInfo();
}

function postSelectionInfo(): void {
  post({ type: "selection-info", component: describeSelection() });
}

function describeSelection(): SelectedFigmaComponent {
  if (figma.currentPage.selection.length > 1) {
    return {
      nodeId: null,
      name: "Multiple layers selected",
      type: "Multiple",
      width: 0,
      height: 0,
      childCount: 0,
      textSample: "",
      hasRtlText: false,
      hasSelection: false,
      styleSummary: "Select one component, frame, or layer to audit."
    };
  }

  const selected = figma.currentPage.selection[0];
  if (!selected) {
    return {
      nodeId: null,
      name: "No component selected",
      type: "None",
      width: 0,
      height: 0,
      childCount: 0,
      textSample: "",
      hasRtlText: false,
      hasSelection: false,
      styleSummary: "Select the design component you want to compare."
    };
  }

  const textSample = collectTextSample(selected);
  return {
    nodeId: selected.id,
    name: selected.name || selected.type,
    type: readableNodeType(selected.type),
    width: "width" in selected && typeof selected.width === "number" ? Math.round(selected.width) : 0,
    height: "height" in selected && typeof selected.height === "number" ? Math.round(selected.height) : 0,
    childCount: countDescendants(selected),
    textSample,
    hasRtlText: hasRtlText(textSample),
    hasSelection: true,
    styleSummary: summarizeSelectedStyles(selected)
  };
}

function summarizeSelectedStyles(node: SceneNode): string {
  const parts: string[] = [];
  const runtimeNode = node as SceneNode & Record<string, unknown>;
  if (hasVisiblePaint(runtimeNode.fills)) parts.push("fills");
  if (hasVisiblePaint(runtimeNode.strokes)) parts.push("strokes");
  if (hasVisibleEffect(runtimeNode.effects)) parts.push("effects");
  if (node.type === "TEXT") parts.push("text");
  if ("children" in node) parts.push(`${node.children.length} layer${node.children.length === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "No visible styles detected.";
}

function hasVisiblePaint(value: unknown): boolean {
  return Array.isArray(value) && value.some((paint) => paint && paint.visible !== false);
}

function hasVisibleEffect(value: unknown): boolean {
  return Array.isArray(value) && value.some((effect) => effect && effect.visible !== false);
}

function readableNodeType(type: SceneNode["type"]): string {
  return type.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function collectTextSample(node: SceneNode): string {
  const texts: string[] = [];
  const queue: SceneNode[] = [node];

  while (queue.length && texts.join(" ").length < 800) {
    const current = queue.shift();
    if (!current) continue;
    if (current.type === "TEXT" && current.characters.trim()) texts.push(current.characters.trim());
    if ("children" in current) queue.push(...Array.from(current.children));
  }

  return texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 800);
}

function countDescendants(node: SceneNode): number {
  if (!("children" in node)) return 0;
  let count = 0;
  const queue = Array.from(node.children);

  while (queue.length && count < 2000) {
    const current = queue.shift();
    if (!current) continue;
    count += 1;
    if ("children" in current) queue.push(...Array.from(current.children));
  }

  return count;
}

function hasRtlText(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

function post(message: ControllerToUiMessage): void {
  figma.ui.postMessage(message);
}
