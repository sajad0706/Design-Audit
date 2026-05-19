import type { ProductionReference, SelectedFigmaComponent } from "../shared/types";

export const AUTO_SELECT_CONFIDENCE = 70;
export const AMBIGUOUS_SCORE_GAP = 8;

// Re-ranks detected production candidates using the selected Figma layer as context.
export function rankReferenceForSelection(reference: ProductionReference, selected: SelectedFigmaComponent | null): ProductionReference {
  if (!selected?.hasSelection) return reference;

  return {
    ...reference,
    components: reference.components
      .slice()
      .map((component) => addSelectionMatch(component, selected))
      .sort((left, right) => componentDisplayScore(right) - componentDisplayScore(left))
  };
}

export function componentDisplayScore(component: ProductionReference["components"][number] | undefined): number {
  if (!component) return 0;
  return component.matchScore ?? component.confidence;
}

export function hasHardMatchWarning(component: ProductionReference["components"][number] | undefined): boolean {
  return Boolean(component?.matchWarnings?.some((warning) => /layout wrapper|small control|No Persian text/i.test(warning)));
}

function addSelectionMatch(
  component: ProductionReference["components"][number],
  selected: SelectedFigmaComponent
): ProductionReference["components"][number] {
  const match = componentMatch(component, selected);
  return {
    ...component,
    matchScore: match.score,
    matchReasons: match.reasons,
    matchWarnings: match.warnings
  };
}

function componentMatch(
  component: ProductionReference["components"][number],
  selected: SelectedFigmaComponent
): { score: number; reasons: string[]; warnings: string[] } {
  const haystack = normalizeText(`${component.name} ${component.sourceFile || ""} ${component.html}`);
  const selectedName = normalizeText(selected.name);
  const candidate = estimateCandidateSignals(component.html, component.css);
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 30 + component.confidence * 0.28;
  let scoreCap = 99;

  if (selectedName && (haystack.includes(selectedName) || selectedName.includes(normalizeText(component.name)))) {
    score += 8;
    reasons.push("Name looks related");
  }

  const textOverlap = textOverlapInfo(selected.textSample, candidate.text);
  if (textOverlap.score) {
    score += textOverlap.score;
    reasons.push(`${textOverlap.count} shared text label${textOverlap.count === 1 ? "" : "s"}`);
  }

  if (selected.hasRtlText && candidate.hasRtlText) {
    score += 16;
    reasons.push("RTL/Persian text matches");
  } else if (selected.hasRtlText && !candidate.hasRtlText) {
    score -= 18;
    scoreCap = Math.min(scoreCap, 66);
    warnings.push("No Persian text found");
  }

  const dimension = dimensionMatchInfo(selected.width, selected.height, candidate.width, candidate.height);
  score += dimension.score;
  if (dimension.reason) reasons.push(dimension.reason);
  if (dimension.warning) warnings.push(dimension.warning);

  const densityScore = structureSimilarityScore(selected.childCount, candidate.elementCount);
  if (densityScore > 4) {
    score += densityScore;
    reasons.push("Structure density is similar");
  }

  if (candidate.repeatedPattern) {
    score += 12;
    reasons.push("Repeated rows/items detected");
  }

  if (candidate.tableLike) {
    score += 10;
    reasons.push("Table/list pattern detected");
  }

  if (candidate.componentBoundary) {
    score += 8;
    reasons.push("Component boundary detected");
  }

  if (candidate.genericWrapper) {
    score -= 32;
    scoreCap = Math.min(scoreCap, 64);
    warnings.push("Looks like a layout wrapper");
  }

  if (candidate.tinyControl) {
    score -= 30;
    scoreCap = Math.min(scoreCap, 58);
    warnings.push("Looks like a small control");
  }

  if (selected.type === "Text" || selected.childCount === 0) {
    warnings.push("Select the parent frame for a stronger match");
  }

  return {
    score: Math.max(0, Math.min(scoreCap, Math.round(score))),
    reasons: uniqueStrings(reasons).slice(0, 4),
    warnings: uniqueStrings(warnings).slice(0, 3)
  };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\u0600-\u06ffa-z0-9]+/g, "");
}

function estimateCandidateSignals(html: string, css: string): {
  text: string;
  hasRtlText: boolean;
  elementCount: number;
  width: number | null;
  height: number | null;
  repeatedPattern: boolean;
  tableLike: boolean;
  tinyControl: boolean;
  genericWrapper: boolean;
  componentBoundary: boolean;
} {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const elementCount = (html.match(/<([a-z][a-z0-9-]*)\b/gi) || []).length;
  const classNames = Array.from(html.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)).flatMap((match) => match[1].split(/\s+/).filter(Boolean));
  const rootTag = html.match(/^\s*<([a-z][a-z0-9-]*)\b/i)?.[1]?.toLowerCase() || "";
  const rootAttributes = html.match(/^\s*<[a-z][a-z0-9-]*\b([^>]*)>/i)?.[1] || "";
  const width = readDimension(css, "width");
  const height = readDimension(css, "height");
  const rowLikeMatches = html.match(/\b(row|item|card|cell|table|list|grid|market|symbol|price|change)\b/gi) || [];
  const repeatedClass = maxDuplicate(classNames) >= 3;
  const tableLike = /<table\b|<tbody\b|<tr\b|<ul\b|<ol\b|\b(table|list|grid|market|price|symbol|ticker)\b/i.test(html);
  const tinyControl = /^(button|a|span|svg|i)$/.test(rootTag) && elementCount <= 4 && text.length < 32;
  const componentBoundary = /data-component\s*=|role\s*=\s*["'](?:table|list|region|tabpanel|navigation)["']/i.test(rootAttributes) ||
    /^(section|article|table|ul|ol|form|nav)$/i.test(rootTag);
  const genericWrapper = classNames.length > 0 && classNames.slice(0, 4).every(isGenericClassName) && elementCount > 8 && !componentBoundary;

  return {
    text,
    hasRtlText: /[\u0600-\u06FF]/.test(text),
    elementCount,
    width,
    height,
    repeatedPattern: repeatedClass || rowLikeMatches.length >= 4,
    tableLike,
    tinyControl,
    genericWrapper,
    componentBoundary
  };
}

function textOverlapInfo(selectedText: string, candidateText: string): { score: number; count: number } {
  const selectedWords = significantWords(selectedText);
  if (!selectedWords.length) return { score: 0, count: 0 };
  const candidate = normalizeText(candidateText);
  const matches = selectedWords.filter((word) => candidate.includes(word)).length;
  return { score: Math.min(18, matches * 6), count: matches };
}

function significantWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^\u0600-\u06ffa-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length >= 2);
  return Array.from(new Set(words)).slice(0, 12);
}

function dimensionMatchInfo(
  selectedWidth: number,
  selectedHeight: number,
  candidateWidth: number | null,
  candidateHeight: number | null
): { score: number; reason?: string; warning?: string } {
  if (!selectedWidth || !selectedHeight || !candidateWidth || !candidateHeight) return { score: 0 };
  const widthRatio = Math.min(selectedWidth, candidateWidth) / Math.max(selectedWidth, candidateWidth);
  const heightRatio = Math.min(selectedHeight, candidateHeight) / Math.max(selectedHeight, candidateHeight);
  const average = (widthRatio + heightRatio) / 2;
  if (average >= 0.82) return { score: 18, reason: "Size is close to the Figma selection" };
  if (average >= 0.58) return { score: 8, reason: "Size is in the same range" };
  return { score: -10, warning: "Size looks far from the Figma selection" };
}

function structureSimilarityScore(selectedChildCount: number, elementCount: number): number {
  if (!selectedChildCount || !elementCount) return 0;
  const ratio = Math.min(selectedChildCount, elementCount) / Math.max(selectedChildCount, elementCount);
  return Math.round(ratio * 12);
}

function readDimension(css: string, property: "width" | "height"): number | null {
  const match = css.match(new RegExp(`(?:^|[;\\s{])(?:min-|max-)?${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, "i"));
  return match ? Number(match[1]) : null;
}

function maxDuplicate(values: string[]): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const value of values) {
    const normalized = value.toLowerCase();
    const next = (counts.get(normalized) || 0) + 1;
    counts.set(normalized, next);
    max = Math.max(max, next);
  }
  return max;
}

function isGenericClassName(value: string): boolean {
  return /^(app|root|layout|wrapper|container|content|main|page|screen|flex|grid|row|col|relative|absolute|block|inline|hidden|items-|justify-|gap-|p[trblxy]?-|m[trblxy]?-|w-|h-|min-|max-|basis-|text-|bg-|border-|rounded-|shadow-|overflow-|font-|leading-)/i.test(value);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
