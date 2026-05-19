import type {
  ProductionComponentCandidate,
  ProductionReference,
  ProductionToken,
  SourceInputKind,
  SourceSummary,
  SourceTextFile,
  TokenCategory
} from "../shared/types";
import { dedupeTokens, inferCategory, normalizeColor, normalizeLength, toTokenDisplayName } from "../shared/tokenUtils";

const CSS_VARIABLE_PATTERN = /--([a-zA-Z0-9-_./]+)\s*:\s*([^;}{]+)[;}]/g;
const CSS_PROPERTY_PATTERN = /([a-zA-Z-]+)\s*:\s*([^;}{]+)[;}]/g;
const NAMED_VALUE_PATTERN = /["']?([a-zA-Z0-9_.-]*(?:color|space|spacing|radius|font|type|typography|shadow|elevation)[a-zA-Z0-9_.-]*)["']?\s*[:=]\s*["']([^"']+)["']/gi;

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const SHADOW_PATTERN = /box-shadow\s*:\s*([^;}{]+)/gi;
const CSS_RULE_PATTERN = /([^{}@]+)\{([^{}]+)\}/g;

export const SOURCE_EXTENSIONS = [
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".json",
  ".vue",
  ".svelte",
  ".md",
  ".svg"
];

const MAX_TOKENS = 900;
const MAX_COMPONENTS = 6;
const MAX_PREVIEW_CHARS = 14000;

export function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// Builds the normalized production reference used by the controller scanner.
export function parseProductionSource(files: SourceTextFile[], inputKind: SourceInputKind, label: string): ProductionReference {
  const variableMap = collectCssVariables(files);
  const tokens: ProductionToken[] = [];

  for (const file of files) {
    tokens.push(...extractCssVariableTokens(file, variableMap));
    tokens.push(...extractCssPropertyTokens(file, variableMap));
    tokens.push(...extractNamedSourceTokens(file));
    tokens.push(...extractLooseColorTokens(file));
    tokens.push(...extractShadowTokens(file));
  }

  const deduped = dedupeTokens(tokens).slice(0, MAX_TOKENS);
  const components = detectProductionComponents(files, inputKind, label, deduped);
  return {
    label,
    inputKind,
    tokens: deduped,
    sourceSummary: buildSourceSummary(files, deduped),
    components
  };
}

function collectCssVariables(files: SourceTextFile[]): Map<string, string> {
  const variables = new Map<string, string>();
  for (const file of files) {
    for (const match of file.text.matchAll(CSS_VARIABLE_PATTERN)) {
      variables.set(match[1], cleanValue(match[2]));
    }
  }
  return variables;
}

// Converts CSS custom properties into named design tokens.
function extractCssVariableTokens(file: SourceTextFile, variableMap: Map<string, string>): ProductionToken[] {
  const tokens: ProductionToken[] = [];
  for (const match of file.text.matchAll(CSS_VARIABLE_PATTERN)) {
    const name = match[1];
    const rawValue = cleanValue(match[2]);
    const category = inferCategory(name, rawValue);
    if (!category) continue;
    tokens.push(makeToken({
      name,
      category,
      rawValue: resolveCssValue(rawValue, variableMap),
      sourceFile: file.name,
      cssProperty: `--${name}`
    }));
  }
  return tokens;
}

// Extracts production values from CSS properties such as color, padding, font-size, and border-radius.
function extractCssPropertyTokens(file: SourceTextFile, variableMap: Map<string, string>): ProductionToken[] {
  const tokens: ProductionToken[] = [];
  for (const match of file.text.matchAll(CSS_PROPERTY_PATTERN)) {
    const property = match[1].toLowerCase();
    const rawValue = cleanValue(match[2]);
    const category = categoryFromCssProperty(property, rawValue);
    if (!category) continue;

    const variableName = readCssVariableName(rawValue);
    const tokenName = variableName || `${property}/${tokens.length + 1}`;
    tokens.push(makeToken({
      name: tokenName,
      category,
      rawValue: resolveCssValue(rawValue, variableMap),
      sourceFile: file.name,
      cssProperty: property
    }));
  }
  return tokens;
}

// Finds token-like assignments in JSON, JS, and TS token files.
function extractNamedSourceTokens(file: SourceTextFile): ProductionToken[] {
  const tokens: ProductionToken[] = [];
  for (const match of file.text.matchAll(NAMED_VALUE_PATTERN)) {
    const name = match[1];
    const rawValue = cleanValue(match[2]);
    const category = inferCategory(name, rawValue);
    if (!category) continue;
    tokens.push(makeToken({ name, category, rawValue, sourceFile: file.name }));
  }
  return tokens;
}

// Captures raw colors when a source file has production colors without token names.
function extractLooseColorTokens(file: SourceTextFile): ProductionToken[] {
  const tokens: ProductionToken[] = [];
  for (const match of file.text.matchAll(COLOR_PATTERN)) {
    tokens.push(makeToken({
      name: `production/color/${tokens.length + 1}`,
      category: "color",
      rawValue: match[0],
      sourceFile: file.name
    }));
  }
  return tokens;
}

function extractShadowTokens(file: SourceTextFile): ProductionToken[] {
  const tokens: ProductionToken[] = [];
  for (const match of file.text.matchAll(SHADOW_PATTERN)) {
    tokens.push(makeToken({
      name: `production/effect/${tokens.length + 1}`,
      category: "effect",
      rawValue: cleanValue(match[1]),
      sourceFile: file.name,
      cssProperty: "box-shadow"
    }));
  }
  return tokens;
}

function makeToken(input: {
  name: string;
  category: TokenCategory;
  rawValue: string;
  sourceFile?: string;
  cssProperty?: string;
}): ProductionToken {
  const value = normalizeSourceValue(input.rawValue, input.category);
  return {
    id: `${input.category}:${input.name}:${input.rawValue}`,
    name: input.name,
    displayName: toTokenDisplayName(input.name),
    category: input.category,
    value,
    rawValue: input.rawValue,
    sourceFile: input.sourceFile,
    cssProperty: input.cssProperty
  };
}

function normalizeSourceValue(rawValue: string, category: TokenCategory): string | number {
  if (category === "color") return normalizeColor(rawValue);
  if (category === "spacing" || category === "radius" || category === "typography") {
    return normalizeLength(rawValue);
  }
  return rawValue.trim().toLowerCase();
}

function categoryFromCssProperty(property: string, rawValue: string): TokenCategory | null {
  if (/^(color|background-color|border-color|fill|stroke|caret-color|outline-color)$/.test(property)) return "color";
  if (/radius$/.test(property)) return "radius";
  if (/^(gap|row-gap|column-gap|padding|padding-left|padding-right|padding-top|padding-bottom|margin|margin-left|margin-right|margin-top|margin-bottom|inset)$/.test(property)) {
    return "spacing";
  }
  if (/^(font-family|font-size|font-weight|line-height|letter-spacing)$/.test(property)) return "typography";
  if (/^(box-shadow|filter|backdrop-filter)$/.test(property)) return "effect";
  return inferCategory(property, rawValue, property);
}

function readCssVariableName(value: string): string | null {
  const match = value.match(/var\(--([a-zA-Z0-9-_./]+)\)/);
  return match ? match[1] : null;
}

function resolveCssValue(value: string, variableMap: Map<string, string>): string {
  const variableName = readCssVariableName(value);
  if (variableName && variableMap.has(variableName)) {
    return variableMap.get(variableName) || value;
  }
  return value;
}

function buildSourceSummary(files: SourceTextFile[], tokens: ProductionToken[]): SourceSummary {
  return {
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
    colors: tokens.filter((token) => token.category === "color").length,
    typography: tokens.filter((token) => token.category === "typography").length,
    spacing: tokens.filter((token) => token.category === "spacing").length,
    radius: tokens.filter((token) => token.category === "radius").length,
    effects: tokens.filter((token) => token.category === "effect").length
  };
}

// Finds likely production components and prepares small preview payloads for the UI.
function detectProductionComponents(
  files: SourceTextFile[],
  inputKind: SourceInputKind,
  label: string,
  tokens: ProductionToken[]
): ProductionComponentCandidate[] {
  const candidates: ProductionComponentCandidate[] = [];
  const htmlFiles = files.filter((file) => isHtmlFile(file.name));
  const componentFiles = files.filter((file) => isComponentFile(file.name));
  const cssFiles = files.filter((file) => isStyleFile(file.name));

  for (const file of htmlFiles) {
    const snippets = extractHtmlSnippets(file);
    for (const snippet of snippets) {
      const css = cssForMarkup(files, snippet.html, file.name);
      candidates.push(makeComponentCandidate({
        inputKind,
        label,
        sourceFile: file.name,
        name: snippet.name,
        html: snippet.html,
        css,
        confidence: snippet.confidence + (css ? 14 : 0),
        reason: css ? "Found a main HTML block and related styles." : "Found a main HTML block.",
        tokens
      }));
    }
  }

  for (const file of componentFiles) {
    const preview = extractFrameworkComponentPreview(file, files);
    if (!preview) continue;
    candidates.push(makeComponentCandidate({
      inputKind,
      label,
      sourceFile: file.name,
      name: preview.name,
      html: preview.html,
      css: preview.css,
      confidence: preview.confidence,
      reason: preview.reason,
      tokens
    }));
  }

  if (!candidates.length) {
    for (const file of cssFiles) {
      const cssPreview = extractCssOnlyPreview(file, files);
      if (!cssPreview) continue;
      candidates.push(makeComponentCandidate({
        inputKind,
        label,
        sourceFile: file.name,
        name: cssPreview.name,
        html: cssPreview.html,
        css: cssPreview.css,
        confidence: cssPreview.confidence,
        reason: cssPreview.reason,
        tokens
      }));
    }
  }

  return dedupeComponents(candidates)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, MAX_COMPONENTS);
}

function makeComponentCandidate(input: {
  inputKind: SourceInputKind;
  label: string;
  sourceFile: string;
  name: string;
  html: string;
  css: string;
  confidence: number;
  reason: string;
  tokens: ProductionToken[];
}): ProductionComponentCandidate {
  const safeHtml = truncatePreviewHtml(input.html);
  const safeCss = truncatePreviewCss(input.css);
  const tokenIds = componentTokenIds(input.tokens, input.sourceFile, `${safeHtml}\n${safeCss}`);
  const confidence = Math.max(0, Math.min(100, Math.round(input.confidence)));

  return {
    id: `${slugify(input.sourceFile)}-${slugify(input.name)}-${shortHash(safeHtml)}`,
    name: input.name || humanizeName(input.sourceFile),
    sourceLabel: input.label,
    sourceFile: input.sourceFile,
    inputKind: input.inputKind,
    confidence,
    html: safeHtml,
    css: safeCss,
    summary: summarizeComponent(safeHtml, safeCss),
    reason: input.reason,
    tokenIds
  };
}

function extractHtmlSnippets(file: SourceTextFile): Array<{ name: string; html: string; confidence: number }> {
  const html = stripUnsafeMarkup(file.text);
  if (!html.trim()) return [];

  if (typeof DOMParser === "undefined") {
    return [{
      name: humanizeName(file.name),
      html,
      confidence: 58
    }];
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const bodyChildren = Array.from(doc.body.children);
  const roots = bodyChildren.length ? bodyChildren : Array.from(doc.children);
  const scored = roots
    .map((element) => ({ element, score: scoreHtmlElement(element) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (!scored.length && html.trim()) {
    return [{
      name: humanizeName(file.name),
      html,
      confidence: 48
    }];
  }

  return scored.slice(0, 4).map(({ element, score }) => ({
    name: nameFromElement(element, file.name),
    html: stripUnsafeMarkup(element.outerHTML),
    confidence: Math.min(84, 44 + score)
  }));
}

function extractFrameworkComponentPreview(
  file: SourceTextFile,
  files: SourceTextFile[]
): { name: string; html: string; css: string; confidence: number; reason: string } | null {
  const name = componentNameFromSource(file);
  const template = extractTemplateBlock(file.text, file.name);
  if (template) {
    return {
      name,
      html: stripUnsafeMarkup(template),
      css: cssForMarkup(files, template, file.name),
      confidence: 78,
      reason: "Found a component template and related styles."
    };
  }

  const classNames = Array.from(file.text.matchAll(/className\s*=\s*["']([^"']+)["']/g)).map((match) => match[1]);
  const className = classNames.find(Boolean) || "";
  const tagName = inferRootTag(file.text);
  const label = humanizeName(name);

  if (!className && !hasComponentSignature(file)) return null;

  const html = `<${tagName}${className ? ` class="${escapeAttribute(className)}"` : ""}>${escapeHtml(label)}</${tagName}>`;
  return {
    name,
    html,
    css: cssForMarkup(files, html, file.name),
    confidence: className ? 66 : 46,
    reason: className ? "Found a component file with matching class names." : "Found a component file."
  };
}

function extractCssOnlyPreview(file: SourceTextFile, files: SourceTextFile[]): { name: string; html: string; css: string; confidence: number; reason: string } | null {
  for (const match of file.text.matchAll(CSS_RULE_PATTERN)) {
    const selector = match[1].split(",").map((part) => part.trim()).find((part) => /^[.#][a-zA-Z0-9_-]+/.test(part));
    if (!selector) continue;
    const className = selector.match(/\.([a-zA-Z0-9_-]+)/)?.[1];
    const idName = selector.match(/#([a-zA-Z0-9_-]+)/)?.[1];
    const name = humanizeName(className || idName || file.name);
    const html = className
      ? `<div class="${escapeAttribute(className)}">${escapeHtml(name)}</div>`
      : `<div id="${escapeAttribute(idName || "production-component")}">${escapeHtml(name)}</div>`;

    return {
      name,
      html,
      css: cssForMarkup(files, html, file.name),
      confidence: 52,
      reason: "Found a styled selector, but no matching HTML was provided."
    };
  }

  return null;
}

function cssForMarkup(files: SourceTextFile[], html: string, sourceFile: string): string {
  const css = files
    .filter((file) => isStyleFile(file.name) || file.name === sourceFile)
    .map((file) => extractStyleBlocks(file.text) || file.text)
    .join("\n");
  return extractRelevantCss(css, html);
}

function extractRelevantCss(css: string, html: string): string {
  const selectors = selectorsFromHtml(html);
  const parts: string[] = [];
  const rootBlocks = css.match(/:root\s*\{[^{}]*\}/g) || [];
  parts.push(...rootBlocks.slice(0, 4));

  for (const match of css.matchAll(CSS_RULE_PATTERN)) {
    const selector = cleanSelector(match[1]);
    const declarations = match[2].trim();
    if (!selector || !declarations) continue;
    if (!selectorTouchesMarkup(selector, selectors)) continue;
    parts.push(`${selector} { ${declarations} }`);
    if (parts.join("\n").length > MAX_PREVIEW_CHARS) break;
  }

  return parts.length ? parts.join("\n\n") : css.slice(0, MAX_PREVIEW_CHARS);
}

function selectorsFromHtml(html: string): { classes: string[]; ids: string[]; tags: string[] } {
  const classes = new Set<string>();
  const ids = new Set<string>();
  const tags = new Set<string>();

  for (const match of html.matchAll(/\bclass\s*=\s*["']([^"']+)["']/gi)) {
    match[1].split(/\s+/).filter(Boolean).forEach((item) => classes.add(item));
  }
  for (const match of html.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)) {
    ids.add(match[1]);
  }
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b/gi)) {
    tags.add(match[1].toLowerCase());
  }

  return {
    classes: Array.from(classes),
    ids: Array.from(ids),
    tags: Array.from(tags)
  };
}

function selectorTouchesMarkup(selector: string, selectors: { classes: string[]; ids: string[]; tags: string[] }): boolean {
  const lower = selector.toLowerCase();
  if (selectors.classes.some((className) => lower.includes(`.${className.toLowerCase()}`))) return true;
  if (selectors.ids.some((id) => lower.includes(`#${id.toLowerCase()}`))) return true;
  return selectors.tags.some((tag) => new RegExp(`(^|[\\s>+~,(])${tag}([\\s.#:[>+~),]|$)`, "i").test(selector));
}

function componentTokenIds(tokens: ProductionToken[], sourceFile: string, previewText: string): string[] {
  const normalizedPreview = previewText.toLowerCase();
  const base = baseName(sourceFile).toLowerCase();
  const matches = tokens.filter((token) => {
    if (token.sourceFile === sourceFile) return true;
    if (token.sourceFile && baseName(token.sourceFile).toLowerCase() === base) return true;
    if (normalizedPreview.includes(String(token.rawValue).toLowerCase())) return true;
    if (normalizedPreview.includes(String(token.name).toLowerCase())) return true;
    return token.cssProperty ? normalizedPreview.includes(token.cssProperty.toLowerCase()) : false;
  });
  return (matches.length ? matches : tokens).map((token) => token.id);
}

function dedupeComponents(candidates: ProductionComponentCandidate[]): ProductionComponentCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.name}:${candidate.sourceFile}:${candidate.html.slice(0, 160)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scoreHtmlElement(element: Element): number {
  let score = 0;
  if (element.getAttribute("data-component")) score += 28;
  if (element.id) score += 18;
  if (element.classList.length) score += 18;
  if (element.getAttribute("role")) score += 8;
  score += Math.min(18, element.querySelectorAll("*").length * 2);
  score += Math.min(10, element.textContent?.trim().length ? 10 : 0);
  return score;
}

function nameFromElement(element: Element, fileName: string): string {
  return humanizeName(
    element.getAttribute("data-component") ||
      element.getAttribute("aria-label") ||
      element.id ||
      Array.from(element.classList)[0] ||
      element.tagName ||
      fileName
  );
}

function componentNameFromSource(file: SourceTextFile): string {
  const patterns = [
    /export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/,
    /function\s+([A-Z][A-Za-z0-9_]*)/,
    /const\s+([A-Z][A-Za-z0-9_]*)\s*=/,
    /class\s+([A-Z][A-Za-z0-9_]*)/
  ];

  for (const pattern of patterns) {
    const match = file.text.match(pattern);
    if (match) return humanizeName(match[1]);
  }

  return humanizeName(file.name);
}

function hasComponentSignature(file: SourceTextFile): boolean {
  if (/\.(tsx|jsx|vue|svelte)$/i.test(file.name)) return true;
  return /export\s+default\s+function\s+[A-Z]|function\s+[A-Z][A-Za-z0-9_]*|const\s+[A-Z][A-Za-z0-9_]*\s*=/.test(file.text);
}

function extractTemplateBlock(text: string, fileName: string): string | null {
  const vueTemplate = text.match(/<template[^>]*>([\s\S]*?)<\/template>/i);
  if (vueTemplate) return vueTemplate[1].trim();
  if (/\.svelte$/i.test(fileName)) {
    const svelteMarkup = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").trim();
    if (svelteMarkup) return svelteMarkup;
  }
  const returnMatch = text.match(/return\s*\(([\s\S]*?)\)\s*;?/);
  if (!returnMatch) return null;
  const jsx = returnMatch[1].trim();
  if (!/^</.test(jsx)) return null;
  return jsx
    .replace(/\bclassName=/g, "class=")
    .replace(/\{[^{}]*\}/g, "")
    .replace(/<\/?React\.Fragment>/g, "");
}

function extractStyleBlocks(text: string): string {
  return Array.from(text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)).map((match) => match[1]).join("\n");
}

function stripUnsafeMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\sjavascript:/gi, "");
}

function truncatePreviewHtml(html: string): string {
  return stripUnsafeMarkup(html).trim().slice(0, MAX_PREVIEW_CHARS);
}

function truncatePreviewCss(css: string): string {
  return css.trim().slice(0, MAX_PREVIEW_CHARS);
}

function summarizeComponent(html: string, css: string): string {
  const selectors = selectorsFromHtml(html);
  const parts = [
    selectors.tags[0] ? `${selectors.tags[0]} element` : "component",
    selectors.classes.length ? `${selectors.classes.slice(0, 2).map((item) => `.${item}`).join(", ")}` : "",
    css ? "with related CSS" : "without related CSS"
  ].filter(Boolean);
  return parts.join(" ");
}

function cleanSelector(selector: string): string {
  return selector
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");
}

function inferRootTag(text: string): string {
  if (/<button\b/i.test(text)) return "button";
  if (/<a\b/i.test(text)) return "a";
  if (/<input\b/i.test(text)) return "input";
  if (/<img\b/i.test(text)) return "figure";
  return "div";
}

function isHtmlFile(name: string): boolean {
  return /\.(html|htm)$/i.test(name);
}

function isStyleFile(name: string): boolean {
  return /\.(css|scss|sass|less)$/i.test(name);
}

function isComponentFile(name: string): boolean {
  return /\.(tsx|jsx|vue|svelte|js)$/i.test(name);
}

function baseName(name: string): string {
  return name.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || name;
}

function humanizeName(value: string): string {
  return baseName(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Production Component";
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "component";
}

function shortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return map[char];
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function cleanValue(value: string): string {
  return String(value || "")
    .replace(/!important/g, "")
    .replace(/,$/, "")
    .trim();
}
