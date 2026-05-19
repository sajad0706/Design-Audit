import type { LayerToken, ProductionToken, ScannedLayer, TokenCategory, TokenValue } from "../shared/types";
import { inferCategory, normalizeName, rgbToHex, toTokenDisplayName, valuesMatch } from "../shared/tokenUtils";

const DEFAULT_RADIUS_VALUES = [0, 2, 4, 8, 12, 16, 24, 32];

export interface DesignTextStyleReference {
  name: string;
  displayName: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeight: number | "auto";
}

export interface DesignLintReference {
  tokens: ProductionToken[];
  textStyles: DesignTextStyleReference[];
  allowedRadiusValues: number[];
  styleCount: number;
  variableCount: number;
}

// Reads local Figma styles and variables so design lint can suggest real file tokens.
export async function collectDesignLintReference(): Promise<DesignLintReference> {
  const [paintStyles, textStyles, effectStyles, variables] = await Promise.all([
    getLocalPaintStyles(),
    getLocalTextStyles(),
    getLocalEffectStyles(),
    getLocalVariables()
  ]);

  const variableTokens = variables.flatMap(variableToTokens);
  const tokens = [
    ...paintStyles.flatMap(paintStyleToTokens),
    ...effectStyles.flatMap(effectStyleToTokens),
    ...variableTokens
  ];

  const allowedRadiusValues = uniqueNumbers([
    ...DEFAULT_RADIUS_VALUES,
    ...variableTokens.filter((token) => token.category === "radius" && typeof token.value === "number").map((token) => token.value as number)
  ]);

  return {
    tokens,
    textStyles: textStyles.map(textStyleToReference),
    allowedRadiusValues,
    styleCount: paintStyles.length + textStyles.length + effectStyles.length,
    variableCount: variables.length
  };
}

export function findMatchingDesignToken(token: LayerToken, reference: DesignLintReference | null | undefined): ProductionToken | undefined {
  if (!reference) return undefined;
  return reference.tokens.find((candidate) => candidate.category === token.category && valuesMatch(candidate.value, token.value, token.category));
}

export function findMatchingTextStyle(layer: ScannedLayer, reference: DesignLintReference | null | undefined): DesignTextStyleReference | undefined {
  if (!reference || layer.nodeType !== "TEXT") return undefined;
  const fontFamily = readTokenValue(layer, "font-family");
  const fontSize = readNumericTokenValue(layer, "font-size");
  const fontWeight = readNumericTokenValue(layer, "font-weight");
  const lineHeight = readNumericTokenValue(layer, "line-height");

  if (!fontFamily || fontSize == null) return undefined;

  return reference.textStyles.find((style) => {
    if (normalizeName(style.fontFamily) !== normalizeName(String(fontFamily))) return false;
    if (!numbersMatch(style.fontSize, fontSize)) return false;
    if (fontWeight != null && !numbersMatch(style.fontWeight, fontWeight)) return false;
    if (style.lineHeight === "auto") return lineHeight == null;
    return lineHeight == null || numbersMatch(style.lineHeight, lineHeight);
  });
}

export function isAllowedRadius(value: number, layer: ScannedLayer, reference: DesignLintReference | null | undefined): boolean {
  if (value === 0 || isFullyRounded(value, layer)) return true;
  const allowedValues = reference?.allowedRadiusValues?.length ? reference.allowedRadiusValues : DEFAULT_RADIUS_VALUES;
  return allowedValues.some((allowed) => numbersMatch(allowed, value));
}

export function formatAllowedRadii(reference: DesignLintReference | null | undefined): string {
  const values = reference?.allowedRadiusValues?.length ? reference.allowedRadiusValues : DEFAULT_RADIUS_VALUES;
  return uniqueNumbers(values)
    .slice(0, 10)
    .map((value) => `${value}px`)
    .join(", ");
}

function paintStyleToTokens(style: PaintStyle): ProductionToken[] {
  const color = firstSolidPaintColor(style.paints);
  if (!color) return [];
  return [makeDesignToken(`style:${style.id}:paint`, style.name, "color", color, "Figma paint style")];
}

function effectStyleToTokens(style: EffectStyle): ProductionToken[] {
  const effects = style.effects.filter((effect) => effect.visible !== false);
  if (!effects.length) return [];
  return [makeDesignToken(`style:${style.id}:effect`, style.name, "effect", formatEffects(effects), "Figma effect style")];
}

function textStyleToReference(style: TextStyle): DesignTextStyleReference {
  return {
    name: style.name,
    displayName: toTokenDisplayName(style.name),
    fontFamily: style.fontName.family,
    fontWeight: inferFontWeight(style.fontName.style),
    fontSize: style.fontSize,
    lineHeight: normalizeLineHeight(style.lineHeight)
  };
}

function variableToTokens(variable: Variable): ProductionToken[] {
  const value = readVariableValue(variable);
  if (value == null) return [];

  const category = inferVariableCategory(variable, value);
  if (!category) return [];

  const name = variable.codeSyntax.WEB || variable.name;
  return [makeDesignToken(`variable:${variable.id}`, name, category, value, "Figma variable")];
}

function inferVariableCategory(variable: Variable, value: TokenValue): TokenCategory | null {
  if (variable.resolvedType === "COLOR") return "color";
  if (variable.resolvedType === "FLOAT") {
    return inferCategory(variable.name, String(value)) || "spacing";
  }
  return inferCategory(variable.name, String(value));
}

function makeDesignToken(id: string, name: string, category: TokenCategory, value: TokenValue, sourceFile: string): ProductionToken {
  return {
    id,
    name,
    displayName: toTokenDisplayName(name),
    category,
    value,
    rawValue: String(value),
    sourceFile
  };
}

async function getLocalPaintStyles(): Promise<PaintStyle[]> {
  return figma.getLocalPaintStylesAsync ? figma.getLocalPaintStylesAsync() : figma.getLocalPaintStyles();
}

async function getLocalTextStyles(): Promise<TextStyle[]> {
  return figma.getLocalTextStylesAsync ? figma.getLocalTextStylesAsync() : figma.getLocalTextStyles();
}

async function getLocalEffectStyles(): Promise<EffectStyle[]> {
  return figma.getLocalEffectStylesAsync ? figma.getLocalEffectStylesAsync() : figma.getLocalEffectStyles();
}

async function getLocalVariables(): Promise<Variable[]> {
  if (!figma.variables) return [];
  return figma.variables.getLocalVariablesAsync ? figma.variables.getLocalVariablesAsync() : figma.variables.getLocalVariables();
}

function readVariableValue(variable: Variable): TokenValue | null {
  const value = Object.values(variable.valuesByMode).find((candidate) => !isVariableAlias(candidate));
  if (value == null) return null;
  if (variable.resolvedType === "COLOR" && isRgb(value)) return rgbToHex(value);
  if (variable.resolvedType === "FLOAT" && typeof value === "number") return value;
  if (variable.resolvedType === "STRING" && typeof value === "string") return value;
  return null;
}

function isVariableAlias(value: VariableValue): boolean {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "VARIABLE_ALIAS");
}

function isRgb(value: VariableValue): value is RGB {
  return Boolean(value && typeof value === "object" && "r" in value && "g" in value && "b" in value);
}

function firstSolidPaintColor(paints: readonly Paint[]): string | null {
  const paint = paints.find((item) => item.type === "SOLID" && item.visible !== false);
  return paint && paint.type === "SOLID" ? rgbToHex(paint.color) : null;
}

function readTokenValue(layer: ScannedLayer, field: LayerToken["field"]): TokenValue | null {
  return layer.tokens.find((token) => token.field === field)?.value ?? null;
}

function readNumericTokenValue(layer: ScannedLayer, field: LayerToken["field"]): number | null {
  const value = readTokenValue(layer, field);
  return typeof value === "number" ? value : null;
}

function normalizeLineHeight(lineHeight: LineHeight): number | "auto" {
  if (lineHeight.unit === "AUTO") return "auto";
  return Math.round(lineHeight.value * 100) / 100;
}

function formatEffects(effects: readonly Effect[]): string {
  return effects.map(formatEffect).join(" | ");
}

function formatEffect(effect: Effect): string {
  const radius = "radius" in effect ? effect.radius : 0;
  const base = effect.type.toLowerCase().replace(/_/g, "-");

  if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
    return `${base} ${effect.offset.x}px ${effect.offset.y}px ${radius}px ${effect.spread}px ${rgbToHex(effect.color)}`;
  }

  return `${base} ${radius}px`;
}

function inferFontWeight(style: string): number {
  const lower = style.toLowerCase();
  if (/\bthin\b/.test(lower)) return 100;
  if (/extra\s*light|ultra\s*light/.test(lower)) return 200;
  if (/\blight\b/.test(lower)) return 300;
  if (/\bmedium\b/.test(lower)) return 500;
  if (/semi\s*bold|demi\s*bold/.test(lower)) return 600;
  if (/\bbold\b/.test(lower)) return 700;
  if (/extra\s*bold|ultra\s*bold/.test(lower)) return 800;
  if (/\bblack\b|heavy/.test(lower)) return 900;
  return 400;
}

function isFullyRounded(value: number, layer: ScannedLayer): boolean {
  const shortestSide = Math.min(layer.width, layer.height);
  return shortestSide > 0 && value >= shortestSide / 2;
}

function numbersMatch(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.5;
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values.map((value) => Math.round(value * 100) / 100))).sort((left, right) => left - right);
}
