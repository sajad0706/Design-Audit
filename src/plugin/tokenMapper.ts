import type { LayerToken, ProductionToken, TokenCategory } from "../shared/types";
import { normalizeName, normalizeTokenValue, valuesMatch } from "../shared/tokenUtils";

export interface ProductionTokenIndex {
  byCategory: Record<TokenCategory, ProductionToken[]>;
  byName: Map<string, ProductionToken>;
}

export interface TokenMatch {
  status: "ok" | "missing-token" | "mismatch" | "no-production-token";
  expected?: ProductionToken;
  actualDisplay: string;
}

const CATEGORIES: TokenCategory[] = ["color", "typography", "spacing", "radius", "effect"];

// Creates a fast lookup table for production token name and value checks.
export function createProductionTokenIndex(tokens: ProductionToken[]): ProductionTokenIndex {
  const byCategory: Record<TokenCategory, ProductionToken[]> = {
    color: [],
    typography: [],
    spacing: [],
    radius: [],
    effect: []
  };
  const byName = new Map<string, ProductionToken>();

  for (const token of tokens) {
    byCategory[token.category].push(token);
    byName.set(normalizeName(token.name), token);
    byName.set(normalizeName(token.displayName), token);
  }

  return { byCategory, byName };
}

// Maps a Figma layer token to the closest matching production token.
export function mapFigmaTokenToProduction(layerToken: LayerToken, index: ProductionTokenIndex): TokenMatch {
  const productionTokens = compatibleProductionTokens(layerToken, index.byCategory[layerToken.category] || []);
  if (!productionTokens.length) {
    return { status: "no-production-token", actualDisplay: layerToken.displayValue };
  }

  const boundName = layerToken.figmaVariableName || layerToken.figmaStyleName || "";
  const nameMatch = boundName ? findByCompatibleName(boundName, index, layerToken.category) : undefined;
  const valueMatch = productionTokens.find((token) => valuesMatch(layerToken.value, token.value, layerToken.category));

  if (nameMatch && valuesMatch(layerToken.value, nameMatch.value, layerToken.category)) {
    return { status: "ok", expected: nameMatch, actualDisplay: layerToken.displayValue };
  }

  if (valueMatch && !layerToken.hasStyleBinding && !layerToken.hasVariableBinding) {
    return { status: "missing-token", expected: valueMatch, actualDisplay: layerToken.displayValue };
  }

  if (valueMatch) {
    return { status: "ok", expected: valueMatch, actualDisplay: layerToken.displayValue };
  }

  return {
    status: "mismatch",
    expected: findClosestProductionToken(layerToken, productionTokens),
    actualDisplay: layerToken.displayValue
  };
}

function compatibleProductionTokens(layerToken: LayerToken, tokens: ProductionToken[]): ProductionToken[] {
  if (layerToken.category !== "typography") return tokens;
  return tokens.filter((token) => isCompatibleTypographyToken(layerToken.field, token));
}

function isCompatibleTypographyToken(field: LayerToken["field"], token: ProductionToken): boolean {
  const text = normalizeName(`${token.name} ${token.displayName} ${token.cssProperty || ""}`);
  if (field === "font-family") return /font-family|family/.test(text);
  if (field === "font-size") return /font-size|type.*size|typography.*size|text.*size|\bsize\b/.test(text);
  if (field === "font-weight") return /font-weight|weight|regular|medium|bold|semibold/.test(text);
  if (field === "line-height") return /line-height|leading/.test(text);
  return true;
}

function findByCompatibleName(name: string, index: ProductionTokenIndex, category: TokenCategory): ProductionToken | undefined {
  const normalized = normalizeName(name);
  const direct = index.byName.get(normalized);
  if (direct && direct.category === category) return direct;
  return index.byCategory[category].find((token) => {
    const tokenName = normalizeName(token.name);
    return tokenName === normalized || tokenName.endsWith(normalized) || normalized.endsWith(tokenName);
  });
}

function findClosestProductionToken(layerToken: LayerToken, tokens: ProductionToken[]): ProductionToken {
  if (typeof normalizeTokenValue(layerToken.value, layerToken.category) === "number") {
    const actual = normalizeTokenValue(layerToken.value, layerToken.category) as number;
    const numericTokens = tokens
      .map((token) => ({ token, value: normalizeTokenValue(token.value, layerToken.category) }))
      .filter((item): item is { token: ProductionToken; value: number } => typeof item.value === "number");
    if (numericTokens.length) {
      return numericTokens
        .sort((left, right) => Math.abs(left.value - actual) - Math.abs(right.value - actual))[0].token;
    }
  }
  return tokens[0];
}
