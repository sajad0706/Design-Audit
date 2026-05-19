import type { ProductionToken, TokenCategory, TokenValue } from "./types";

export const CATEGORY_LABELS: Record<TokenCategory, string> = {
  color: "Color",
  typography: "Typography",
  spacing: "Spacing",
  radius: "Border radius",
  effect: "Effects"
};

export function normalizeName(value: string): string {
  return String(value || "")
    .replace(/^--/, "")
    .replace(/^\$/, "")
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function toTokenDisplayName(name: string): string {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "production token";
  if (trimmed.startsWith("$")) return trimmed;
  if (trimmed.startsWith("--")) return `$${trimmed.slice(2)}`;
  if (/^production\//.test(trimmed)) return trimmed;
  return `$${trimmed.replace(/[./\s]+/g, "-")}`;
}

export function normalizeTokenValue(value: TokenValue, category: TokenCategory): TokenValue {
  if (category === "color") return normalizeColor(value);
  if (category === "spacing" || category === "radius") return normalizeLength(value);
  if (category === "typography") {
    const numeric = normalizeLength(value);
    if (typeof numeric === "number") return numeric;
    const weight = normalizeFontWeight(value);
    if (weight != null) return weight;
    return String(value).trim().toLowerCase();
  }
  return String(value).trim().toLowerCase();
}

export function valuesMatch(left: TokenValue, right: TokenValue, category: TokenCategory): boolean {
  const normalizedLeft = normalizeTokenValue(left, category);
  const normalizedRight = normalizeTokenValue(right, category);
  if (typeof normalizedLeft === "number" && typeof normalizedRight === "number") {
    return Math.abs(normalizedLeft - normalizedRight) <= 0.5;
  }
  return String(normalizedLeft).toLowerCase() === String(normalizedRight).toLowerCase();
}

export function formatTokenValue(value: TokenValue, category: TokenCategory): string {
  const normalized = normalizeTokenValue(value, category);
  if (typeof normalized === "number") return `${stripTrailingZero(normalized)}px`;
  return String(normalized);
}

export function normalizeColor(value: TokenValue): string {
  const text = String(value || "").trim().toLowerCase();
  const named = namedColor(text);
  if (named) return named;
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  if (/^#[0-9a-f]{4}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}${text[4]}${text[4]}`;
  }
  if (/^#[0-9a-f]{8}$/i.test(text)) return text.slice(0, 9);
  if (/^#[0-9a-f]{6}$/i.test(text)) return text.slice(0, 7);

  const rgb = text.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = parseColorFunctionParts(rgb[1]);
    if (parts.length >= 3) {
      return rgbToHex({
        r: normalizeRgbChannel(parts[0]),
        g: normalizeRgbChannel(parts[1]),
        b: normalizeRgbChannel(parts[2])
      }, parseAlpha(parts[3]));
    }
  }

  return text;
}

export function normalizeLength(value: TokenValue): TokenValue {
  if (typeof value === "number") return round(value);
  const text = String(value || "").trim().toLowerCase();
  const numeric = text.match(/-?\d+(?:\.\d+)?/);
  if (!numeric) return text;
  const amount = Number.parseFloat(numeric[0]);
  if (text.includes("rem")) return round(amount * 16);
  if (text.includes("em")) return round(amount * 16);
  return round(amount);
}

export function rgbToHex(color: { r: number; g: number; b: number }, alpha = 1): string {
  const toByte = (channel: number) => Number.isFinite(channel) ? Math.max(0, Math.min(255, Math.round(channel * 255))) : 0;
  const base = `#${toByte(color.r).toString(16).padStart(2, "0")}${toByte(color.g)
    .toString(16)
    .padStart(2, "0")}${toByte(color.b).toString(16).padStart(2, "0")}`;
  if (alpha >= 0.995) return base;
  return `${base}${toByte(alpha).toString(16).padStart(2, "0")}`;
}

export function dedupeTokens(tokens: ProductionToken[]): ProductionToken[] {
  const seen = new Set<string>();
  return tokens.filter((token) => {
    const key = `${token.category}:${normalizeName(token.name)}:${normalizeTokenValue(token.value, token.category)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function inferCategory(name: string, rawValue: string, cssProperty = ""): TokenCategory | null {
  const combined = `${name} ${cssProperty}`.toLowerCase();
  const value = String(rawValue || "").toLowerCase();
  if (/^#|rgba?\(|hsla?\(|^(transparent|black|white)$/.test(value)) return "color";
  if (/color|background|bg|border-color|fill|stroke|surface|foreground/.test(combined)) {
    return "color";
  }
  if (/radius|rounded|corner/.test(combined)) return "radius";
  if (/space|spacing|gap|padding|margin|inset/.test(combined)) return "spacing";
  if (/font|type|typography|line-height|letter-spacing|weight|leading/.test(combined)) return "typography";
  if (/shadow|elevation|blur|effect/.test(combined)) return "effect";
  return null;
}

function parseColorFunctionParts(value: string): string[] {
  return value
    .trim()
    .replace(/\s*\/\s*/g, ",")
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeRgbChannel(part: string): number {
  if (part.endsWith("%")) return Number.parseFloat(part) / 100;
  return Number.parseFloat(part) / 255;
}

function parseAlpha(part: string | undefined): number {
  if (!part) return 1;
  if (part.endsWith("%")) return Math.max(0, Math.min(1, Number.parseFloat(part) / 100));
  return Math.max(0, Math.min(1, Number.parseFloat(part)));
}

function normalizeFontWeight(value: TokenValue): number | null {
  const text = String(value || "").trim().toLowerCase();
  if (text === "thin") return 100;
  if (text === "extra light" || text === "extralight" || text === "ultra light" || text === "ultralight") return 200;
  if (text === "light") return 300;
  if (text === "normal" || text === "regular") return 400;
  if (text === "medium") return 500;
  if (text === "semi bold" || text === "semibold" || text === "demi bold" || text === "demibold") return 600;
  if (text === "bold") return 700;
  if (text === "extra bold" || text === "extrabold" || text === "ultra bold" || text === "ultrabold") return 800;
  if (text === "black" || text === "heavy") return 900;
  return null;
}

function namedColor(value: string): string | null {
  if (value === "black") return "#000000";
  if (value === "white") return "#ffffff";
  if (value === "transparent") return "#00000000";
  return null;
}

function stripTrailingZero(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
