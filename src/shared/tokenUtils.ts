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
    return typeof numeric === "number" ? numeric : String(value).trim().toLowerCase();
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
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    return `#${text[1]}${text[1]}${text[2]}${text[2]}${text[3]}${text[3]}`;
  }
  if (/^#[0-9a-f]{6}/i.test(text)) return text.slice(0, 7);

  const rgb = text.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const parts = rgb[1].split(/,\s*/).map((part) => Number.parseFloat(part));
    if (parts.length >= 3) {
      return rgbToHex({
        r: parts[0] / 255,
        g: parts[1] / 255,
        b: parts[2] / 255
      });
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

export function rgbToHex(color: { r: number; g: number; b: number }): string {
  const toByte = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * 255)));
  return `#${toByte(color.r).toString(16).padStart(2, "0")}${toByte(color.g)
    .toString(16)
    .padStart(2, "0")}${toByte(color.b).toString(16).padStart(2, "0")}`;
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
  if (/color|background|bg|border-color|fill|stroke|surface|foreground|text/.test(combined) || /^#|rgb\(|hsl\(/.test(value)) {
    return "color";
  }
  if (/radius|rounded|corner/.test(combined)) return "radius";
  if (/space|spacing|gap|padding|margin|inset/.test(combined)) return "spacing";
  if (/font|type|typography|line-height|letter-spacing/.test(combined)) return "typography";
  if (/shadow|elevation|blur|effect/.test(combined)) return "effect";
  return null;
}

function stripTrailingZero(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
