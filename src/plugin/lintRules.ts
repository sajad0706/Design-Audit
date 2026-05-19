import type { IssueGroup, LayerToken, LintIssue, ScanReport, ScannedLayer } from "../shared/types";
import { CATEGORY_LABELS, valuesMatch } from "../shared/tokenUtils";
import { findMatchingDesignToken, findMatchingTextStyle, formatAllowedRadii, isAllowedRadius, type DesignLintReference } from "./designLint";
import { mapFigmaTokenToProduction, type ProductionTokenIndex } from "./tokenMapper";

interface LintOptions {
  includeProduction: boolean;
  includeDesignLint: boolean;
  designLintReference?: DesignLintReference | null;
}

// Runs style, radius, and production token checks against scanned Figma layers.
export function lintScannedLayers(layers: ScannedLayer[], index: ProductionTokenIndex | null, sourceLabel: string, options: LintOptions): ScanReport {
  const issues = layers.flatMap((layer) => [
    ...detectMissingStyles(layer, options.includeProduction ? index : null, options.designLintReference),
    ...(options.includeProduction && index ? compareLayerTokens(layer, index) : []),
    ...(options.includeDesignLint ? detectDesignLintIssues(layer, options.designLintReference) : [])
  ]);

  const sorted = sortIssues(dedupeIssues(issues));
  return {
    sourceLabel,
    scannedLayers: layers.length,
    summary: summarizeIssues(sorted),
    issues: sorted
  };
}

function detectMissingStyles(layer: ScannedLayer, index: ProductionTokenIndex | null, designReference?: DesignLintReference | null): LintIssue[] {
  const issues: LintIssue[] = [];

  if (layer.nodeType === "TEXT" && !layer.hasTextStyle) {
    const textStyle = findMatchingTextStyle(layer, designReference);
    const fontSizeToken = layer.tokens.find((token) => token.field === "font-size");
    const expected = textStyle?.displayName || expectedTokenName(fontSizeToken, index, designReference) || "A typography style";

    issues.push(makeIssue({
      layer,
      issueType: "Missing text style",
      group: "Missing styles",
      field: "text-style",
      actual: "No text style",
      expected,
      problem: "This text is not linked to a text style.",
      suggestedFix: `Apply ${expected}.`
    }));
  }

  if (layer.hasVisibleFill && !layer.hasFillStyle && !layer.hasFillVariable) {
    const fillToken = layer.tokens.find((token) => token.field === "fill");
    const expected = expectedTokenName(fillToken, index, designReference) || "A color style or variable";
    issues.push(makeIssue({
      layer,
      issueType: "Missing fill style",
      group: "Missing styles",
      field: "fill",
      actual: fillToken?.displayValue || "Unlinked fill",
      expected,
      problem: "This fill is not linked to a color style or token.",
      suggestedFix: `Use ${expected}.`
    }));
  }

  if (layer.hasVisibleStroke && !layer.hasStrokeStyle && !layer.hasStrokeVariable) {
    const strokeToken = layer.tokens.find((token) => token.field === "stroke");
    const expected = expectedTokenName(strokeToken, index, designReference) || "A border color style or variable";
    issues.push(makeIssue({
      layer,
      issueType: "Missing stroke style",
      group: "Missing styles",
      field: "stroke",
      actual: strokeToken?.displayValue || "Unlinked stroke",
      expected,
      problem: "This stroke is not linked to a stroke style or token.",
      suggestedFix: `Use ${expected}.`
    }));
  }

  if (layer.hasVisibleEffect && !layer.hasEffectStyle && !layer.hasEffectVariable) {
    const effectToken = layer.tokens.find((token) => token.field === "effect");
    const expected = expectedTokenName(effectToken, index, designReference) || "An effect style";
    issues.push(makeIssue({
      layer,
      issueType: "Missing effect style",
      group: "Missing styles",
      field: "effect",
      actual: effectToken?.displayValue || "Unlinked effect",
      expected,
      problem: "This shadow or blur is not linked to an effect style.",
      suggestedFix: `Apply ${expected}.`
    }));
  }

  return issues;
}

function detectDesignLintIssues(layer: ScannedLayer, designReference?: DesignLintReference | null): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const token of layer.tokens) {
    if (token.category === "radius" && typeof token.value === "number" && !token.hasVariableBinding && !isAllowedRadius(token.value, layer, designReference)) {
      issues.push(makeIssue({
        layer,
        issueType: "Radius off scale",
        group: "Border radius",
        field: token.field,
        actual: token.displayValue,
        expected: formatAllowedRadii(designReference),
        problem: `Using ${token.displayValue}.`,
        suggestedFix: "Use a radius from the design system.",
        severity: "warning"
      }));
    }

    if (token.category === "spacing" && !token.hasVariableBinding) {
      const match = findMatchingDesignToken(token, designReference);
      if (!match) continue;
      issues.push(makeIssue({
        layer,
        issueType: "Missing spacing variable",
        group: "Spacing",
        field: token.field,
        actual: token.displayValue,
        expected: match.displayName,
        problem: `Using ${token.displayValue} without a spacing variable.`,
        suggestedFix: `Use ${match.displayName}.`,
        severity: "warning"
      }));
    }
  }

  return issues;
}

function compareLayerTokens(layer: ScannedLayer, index: ProductionTokenIndex): LintIssue[] {
  const issues: LintIssue[] = [];

  for (const token of layer.tokens) {
    if (shouldSkipToken(token)) continue;
    const match = mapFigmaTokenToProduction(token, index);
    if (match.status === "ok" || match.status === "no-production-token") continue;

    const expected = match.expected?.displayName || match.expected?.name || `production ${CATEGORY_LABELS[token.category].toLowerCase()} token`;
    const group = groupForToken(token);
    const issueType = match.status === "missing-token" ? `${CATEGORY_LABELS[token.category]} token missing` : `${CATEGORY_LABELS[token.category]} mismatch`;
    const problem = match.status === "missing-token"
      ? `Using ${match.actualDisplay} without a production token.`
      : `Using ${match.actualDisplay}.`;

    issues.push(makeIssue({
      layer,
      issueType,
      group,
      field: token.field,
      actual: match.actualDisplay,
      expected,
      problem,
      suggestedFix: `Use ${expected}.`
    }));
  }

  return issues;
}

function shouldSkipToken(token: LayerToken): boolean {
  if (token.category === "radius" && Number(token.value) === 0) return true;
  if (token.category === "spacing" && Number(token.value) === 0) return true;
  return false;
}

function expectedTokenName(token: LayerToken | undefined, index: ProductionTokenIndex | null, designReference?: DesignLintReference | null): string | null {
  if (!token) return null;
  const productionMatch = findMatchingProductionToken(token, index);
  if (productionMatch) return productionMatch.displayName;
  const designMatch = findMatchingDesignToken(token, designReference);
  return designMatch?.displayName || null;
}

function findMatchingProductionToken(token: LayerToken, index: ProductionTokenIndex | null) {
  if (!index) return undefined;
  return (index.byCategory[token.category] || []).find((candidate) => candidate.category === token.category && valuesMatch(candidate.value, token.value, token.category));
}

function groupForToken(token: LayerToken): IssueGroup {
  if (token.category === "color") return "Color";
  if (token.category === "typography") return "Typography";
  if (token.category === "spacing") return "Spacing";
  if (token.category === "radius") return "Border radius";
  return "Effects";
}

function makeIssue(input: {
  layer: ScannedLayer;
  issueType: string;
  group: IssueGroup;
  field: LintIssue["field"];
  actual: string;
  expected: string;
  problem: string;
  suggestedFix: string;
  severity?: LintIssue["severity"];
}): LintIssue {
  const annotation = `❌ ${input.issueType}: ${input.problem}\n✓ Expected: ${input.expected}`;
  return {
    id: `${input.layer.nodeId}:${input.field}:${input.issueType}`,
    issueType: input.issueType,
    group: input.group,
    severity: input.severity || (input.group === "Missing styles" ? "warning" : "error"),
    nodeId: input.layer.nodeId,
    nodeName: input.layer.nodeName,
    nodePath: input.layer.nodePath,
    field: input.field,
    message: input.problem,
    actual: input.actual,
    expected: input.expected,
    suggestedFix: input.suggestedFix,
    annotation
  };
}

function summarizeIssues(issues: LintIssue[]): Record<IssueGroup, number> {
  return {
    "Missing styles": issues.filter((issue) => issue.group === "Missing styles").length,
    Color: issues.filter((issue) => issue.group === "Color").length,
    Typography: issues.filter((issue) => issue.group === "Typography").length,
    Spacing: issues.filter((issue) => issue.group === "Spacing").length,
    "Border radius": issues.filter((issue) => issue.group === "Border radius").length,
    Effects: issues.filter((issue) => issue.group === "Effects").length
  };
}

function dedupeIssues(issues: LintIssue[]): LintIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.nodeId}:${issue.field}:${issue.issueType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortIssues(issues: LintIssue[]): LintIssue[] {
  const groupRank: Record<IssueGroup, number> = {
    "Missing styles": 0,
    Color: 1,
    Typography: 2,
    Spacing: 3,
    "Border radius": 4,
    Effects: 5
  };

  return issues.slice().sort((left, right) => {
    if (groupRank[left.group] !== groupRank[right.group]) return groupRank[left.group] - groupRank[right.group];
    return left.nodePath.localeCompare(right.nodePath);
  });
}
