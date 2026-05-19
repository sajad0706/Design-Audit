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
const NAMED_NUMERIC_VALUE_PATTERN = /["']?([a-zA-Z0-9_.-]*(?:space|spacing|radius|font|type|typography|weight|size)[a-zA-Z0-9_.-]*)["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)(?:,|\n|$)/gi;

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;
const JS_COLOR_LITERAL_PATTERN = /([a-zA-Z0-9_-]+)\s*:\s*["'](#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|transparent|black|white)["']/gi;
const JS_COLOR_ALIAS_PATTERN = /^["']?([a-zA-Z0-9_-]+)["']?\s*:\s*colors(?:\.([a-zA-Z0-9_-]+)|\[['"]([^'"]+)['"]\])(?:\[['"]([^'"]+)['"]\])?/;
const SHADOW_PATTERN = /box-shadow\s*:\s*([^;}{]+)/gi;
const CSS_RULE_PATTERN = /([^{}@]+)\{([^{}]+)\}/g;
const RTL_TEXT_PATTERN = /[\u0600-\u06FF]/;
const FINANCIAL_TEXT_PATTERN = /(?:[%٪]|[+-]?\d+(?:[.,]\d+)?)/;

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
const MAX_COMPONENTS = 24;
const MAX_PREVIEW_CHARS = 14000;

export function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// Builds the normalized production reference used by the controller scanner.
export function parseProductionSource(files: SourceTextFile[], inputKind: SourceInputKind, label: string): ProductionReference {
  const variableMap = collectCssVariables(files);
  const jsColorMap = collectJsColorValues(files);
  const tokens: ProductionToken[] = [];

  for (const file of files) {
    tokens.push(...extractCssVariableTokens(file, variableMap));
    tokens.push(...extractCssPropertyTokens(file, variableMap));
    tokens.push(...extractJsColorPaletteTokens(file));
    tokens.push(...extractJsThemeAliasTokens(file, jsColorMap));
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

function collectJsColorValues(files: SourceTextFile[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const file of files) {
    const text = stripComments(file.text);
    const topLevel = extractTopLevelColorLiterals(text);
    for (const [name, value] of topLevel) values.set(name, value);

    for (const group of readSimpleObjectBlocks(text)) {
      for (const match of group.body.matchAll(JS_COLOR_LITERAL_PATTERN)) {
        const key = match[1];
        const rawValue = cleanValue(match[2]);
        values.set(`${group.name}.${key}`, rawValue);
        values.set(`${group.name}-${key}`, rawValue);
      }
    }
  }
  return values;
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
    if (property.startsWith("--")) continue;
    const rawValue = cleanValue(match[2]);
    const category = categoryFromCssProperty(property, rawValue);
    if (!category) continue;

    for (const expanded of expandCssPropertyValue(property, rawValue, category, variableMap)) {
      tokens.push(makeToken({
        name: expanded.name || `${property}/${tokens.length + 1}`,
        category,
        rawValue: expanded.rawValue,
        sourceFile: file.name,
        cssProperty: expanded.cssProperty
      }));
    }
  }
  return tokens;
}

function extractJsColorPaletteTokens(file: SourceTextFile): ProductionToken[] {
  const tokens: ProductionToken[] = [];
  const text = stripComments(file.text);
  for (const [name, rawValue] of extractTopLevelColorLiterals(text)) {
    tokens.push(makeToken({ name, category: "color", rawValue, sourceFile: file.name }));
  }

  for (const group of readSimpleObjectBlocks(text)) {
    for (const match of group.body.matchAll(JS_COLOR_LITERAL_PATTERN)) {
      tokens.push(makeToken({
        name: `${group.name}-${match[1]}`,
        category: "color",
        rawValue: cleanValue(match[2]),
        sourceFile: file.name
      }));
    }
  }
  return tokens;
}

function extractJsThemeAliasTokens(file: SourceTextFile, colorMap: Map<string, string>): ProductionToken[] {
  const tokens: ProductionToken[] = [];
  const stack: string[] = [];
  const namespace = themeAliasNamespace(file.name);

  for (const rawLine of stripComments(file.text).split(/\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const alias = line.match(JS_COLOR_ALIAS_PATTERN);
    if (alias) {
      const key = alias[1];
      const group = alias[2] || alias[3] || "";
      const shade = alias[4] || "";
      const rawValue = colorMap.get(shade ? `${group}.${shade}` : group) || colorMap.get(shade ? `${group}-${shade}` : group);
      if (rawValue) {
        const name = [namespace, ...stack, key === "DEFAULT" ? "" : key].filter(Boolean).join("-");
        tokens.push(makeToken({ name, category: "color", rawValue, sourceFile: file.name }));
      }
    }

    const opens = line.match(/^(?:const\s+|exports\.)?([a-zA-Z][a-zA-Z0-9_-]*)\s*(?:=|:)\s*\{/);
    if (opens && !/^module\.exports/.test(line)) stack.push(opens[1]);

    const closeCount = (line.match(/\}/g) || []).length;
    const openCount = (line.match(/\{/g) || []).length;
    for (let index = 0; index < Math.max(0, closeCount - openCount); index += 1) stack.pop();
  }

  return tokens;
}

function themeAliasNamespace(fileName: string): string {
  const name = baseName(fileName);
  const namespaces: Record<string, string> = {
    background: "background",
    text: "text",
    border: "border",
    ringColor: "ring-color",
    boxShadow: "shadow"
  };
  return namespaces[name] || "";
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
  for (const match of file.text.matchAll(NAMED_NUMERIC_VALUE_PATTERN)) {
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
  const match = value.match(/var\(\s*--([a-zA-Z0-9-_./]+)(?:\s*,[^)]*)?\)/);
  return match ? match[1] : null;
}

function readCssVariableNames(value: string): string[] {
  return Array.from(value.matchAll(/var\(\s*--([a-zA-Z0-9-_./]+)(?:\s*,[^)]*)?\)/g)).map((match) => match[1]);
}

function resolveCssValue(value: string, variableMap: Map<string, string>): string {
  const variableName = readCssVariableName(value);
  if (variableName && variableMap.has(variableName)) {
    return variableMap.get(variableName) || value;
  }
  return value;
}

function expandCssPropertyValue(
  property: string,
  rawValue: string,
  category: TokenCategory,
  variableMap: Map<string, string>
): Array<{ name?: string; rawValue: string; cssProperty: string }> {
  const variableNames = readCssVariableNames(rawValue);
  const isLengthCategory = category === "spacing" || category === "radius" || category === "typography";
  const shouldExpand = isLengthCategory && /^(padding|margin|border-radius|border.*radius|gap|inset)$/.test(property);
  const parts = shouldExpand ? splitCssValue(rawValue) : [];

  if (parts.length > 1) {
    return parts.map((part, index) => ({
      name: variableNames[index] || `${property}/${index + 1}`,
      rawValue: resolveCssValue(part, variableMap),
      cssProperty: `${property}/${index + 1}`
    }));
  }

  const variableName = readCssVariableName(rawValue);
  return [{
    name: variableName || `${property}/1`,
    rawValue: resolveCssValue(rawValue, variableMap),
    cssProperty: property
  }];
}

function splitCssValue(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;

  for (const char of value.trim()) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(char) && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
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
        confidence: snippet.confidence + (css ? 18 : 0),
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
    .sort((left, right) => componentSortScore(right) - componentSortScore(left))
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
    return extractHtmlFallback(html, file.name);
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const elements = Array.from(doc.body.querySelectorAll("*"));
  const roots = Array.from(doc.body.children);
  const scored = dedupeDomElements(roots.concat(elements))
    .map((element) => ({ element, score: scoreHtmlElement(element), html: stripUnsafeMarkup(element.outerHTML) }))
    .filter((item) => item.score >= 24 && item.html.trim().length > 0)
    .sort((left, right) => right.score - left.score);

  if (!scored.length && html.trim()) {
    return [{
      name: humanizeName(file.name),
      html,
      confidence: 48
    }];
  }

  return selectDiverseHtmlCandidates(scored, 8).map(({ element, score }) => ({
    name: nameFromElement(element, file.name),
    html: stripUnsafeMarkup(element.outerHTML),
    confidence: confidenceFromElementScore(score)
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
  const variableCss = cssVariablesAsRoot(css);
  const looseCss = looseDeclarationsAsBase(css);
  const utilityCss = utilityPreviewCss(html);
  const relevantCss = extractRelevantCss(css, html);
  return [variableCss, looseCss, utilityCss, relevantCss].filter(Boolean).join("\n\n");
}

function extractRelevantCss(css: string, html: string): string {
  const selectors = selectorsFromHtml(html);
  const parts: string[] = [];
  const rootBlocks = css.match(/(?:html|body|:root)\s*\{[^{}]*\}/g) || [];
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

function cssVariablesAsRoot(css: string): string {
  const variables = new Map<string, string>();
  for (const match of css.matchAll(CSS_VARIABLE_PATTERN)) {
    if (variables.size >= 160) break;
    variables.set(match[1], cleanValue(match[2]));
  }
  if (!variables.size) return "";
  const body = Array.from(variables.entries()).map(([name, value]) => `  --${name}: ${value};`).join("\n");
  return `:root {\n${body}\n}`;
}

function looseDeclarationsAsBase(css: string): string {
  if (/{[^{}]+}/.test(css)) return "";
  const allowed = new Set([
    "-webkit-font-smoothing",
    "-webkit-text-size-adjust",
    "direction",
    "font-family",
    "font-feature-settings",
    "font-variation-settings",
    "tab-size",
    "text-rendering"
  ]);
  const declarations: string[] = [];

  for (const match of css.matchAll(CSS_PROPERTY_PATTERN)) {
    const property = match[1].toLowerCase();
    if (property.startsWith("--") || !allowed.has(property)) continue;
    declarations.push(`  ${property}: ${cleanValue(match[2])};`);
  }

  return declarations.length ? `body {\n${declarations.join("\n")}\n}` : "";
}

function utilityPreviewCss(html: string): string {
  const selectors = selectorsFromHtml(html);
  if (!selectors.classes.length) return "";
  const classes = new Set(selectors.classes);
  const rules: string[] = [];
  const add = (className: string, declarations: string) => {
    if (classes.has(className)) rules.push(`.${escapeCssClass(className)} { ${declarations} }`);
  };

  add("flex", "display: flex;");
  add("inline-flex", "display: inline-flex;");
  add("grid", "display: grid;");
  add("hidden", "display: none;");
  add("flex-row", "flex-direction: row;");
  add("flex-col", "flex-direction: column;");
  add("flex-1", "flex: 1 1 0%;");
  add("grow", "flex-grow: 1;");
  add("shrink-0", "flex-shrink: 0;");
  add("basis-full", "flex-basis: 100%;");
  add("items-center", "align-items: center;");
  add("items-start", "align-items: flex-start;");
  add("items-end", "align-items: flex-end;");
  add("justify-center", "justify-content: center;");
  add("justify-between", "justify-content: space-between;");
  add("justify-start", "justify-content: flex-start;");
  add("justify-end", "justify-content: flex-end;");
  add("w-full", "width: 100%;");
  add("h-full", "height: 100%;");
  add("overflow-auto", "overflow: auto;");
  add("overflow-hidden", "overflow: hidden;");
  add("whitespace-nowrap", "white-space: nowrap;");
  add("rounded", "border-radius: 4px;");
  add("rounded-md", "border-radius: 8px;");
  add("rounded-full", "border-radius: 999px;");
  add("border", "border: 1px solid rgb(var(--borderColor-neutral-secondary, 229 229 229));");
  add("border-b", "border-bottom: 1px solid rgb(var(--borderColor-neutral-secondary, 229 229 229));");
  add("border-collapse", "border-collapse: collapse;");
  add("border-spacing-0", "border-spacing: 0;");
  add("text-right", "text-align: right;");
  add("rtl:text-right", "text-align: right;");
  add("text-left", "text-align: left;");
  add("ltr:text-left", "text-align: left;");
  add("text-center", "text-align: center;");
  add("font-bold", "font-weight: 700;");
  add("font-medium", "font-weight: 500;");
  add("bg-neutral-primary", "background: rgb(var(--backgroundColor-neutral-primary, 255 255 255));");
  add("bg-neutral-secondary", "background: rgb(var(--backgroundColor-neutral-secondary, 243 243 243));");
  add("text-neutral-primary", "color: rgb(var(--textColor-neutral-primary, 30 29 29));");
  add("text-neutral-secondary", "color: rgb(var(--textColor-neutral-secondary, 89 89 89));");
  add("text-brand-primary", "color: rgb(var(--textColor-brand-primary, 22 123 71));");
  add("border-brand-primary", "border-color: rgb(var(--borderColor-brand-primary, 22 123 71));");
  add("border-neutral-secondary", "border-color: rgb(var(--borderColor-neutral-secondary, 243 243 243));");
  add("border-neutral-tertiary", "border-color: rgb(var(--borderColor-neutral-tertiary, 216 216 216));");

  for (const className of classes) {
    const gap = className.match(/^gap(?:-[xy])?-(\d+)$/);
    if (gap) rules.push(`.${escapeCssClass(className)} { gap: ${Number(gap[1]) * 4}px; }`);

    const padding = className.match(/^p([trblxy])?-(\d+)$/);
    if (padding) rules.push(`.${escapeCssClass(className)} { ${spacingDeclaration("padding", padding[1], Number(padding[2]) * 4)} }`);

    const margin = className.match(/^m([trblxy])?-(\d+)$/);
    if (margin) rules.push(`.${escapeCssClass(className)} { ${spacingDeclaration("margin", margin[1], Number(margin[2]) * 4)} }`);

    const width = className.match(/^w-(\d+)$/);
    if (width) rules.push(`.${escapeCssClass(className)} { width: ${Number(width[1]) * 4}px; }`);

    const height = className.match(/^h-(\d+)$/);
    if (height) rules.push(`.${escapeCssClass(className)} { height: ${Number(height[1]) * 4}px; }`);

    const arbitrarySize = className.match(/^(w|h|min-w|min-h|max-w|max-h|basis)-\[(.+)\]$/);
    if (arbitrarySize) {
      const property = arbitrarySizeProperty(arbitrarySize[1]);
      const value = safeArbitraryCssValue(arbitrarySize[2]);
      if (value) rules.push(`.${escapeCssClass(className)} { ${property}: ${value}; }`);
    }

    const arbitraryColor = className.match(/^(bg|text|border)-\[(.+)\]$/);
    if (arbitraryColor) {
      const property = arbitraryColor[1] === "bg" ? "background" : arbitraryColor[1] === "text" ? "color" : "border-color";
      const value = safeArbitraryCssValue(arbitraryColor[2]);
      if (value) rules.push(`.${escapeCssClass(className)} { ${property}: ${value}; }`);
    }
  }

  return rules.join("\n");
}

function arbitrarySizeProperty(prefix: string): string {
  const map: Record<string, string> = {
    w: "width",
    h: "height",
    "min-w": "min-width",
    "min-h": "min-height",
    "max-w": "max-width",
    "max-h": "max-height",
    basis: "flex-basis"
  };
  return map[prefix] || "width";
}

function safeArbitraryCssValue(value: string): string | null {
  const decoded = value.replace(/_/g, " ");
  if (!decoded || /[;{}<>]/.test(decoded)) return null;
  return /^[#a-zA-Z0-9\s%().,+\-*/]+$/.test(decoded) ? decoded : null;
}

function spacingDeclaration(property: "padding" | "margin", axis: string | undefined, value: number): string {
  if (!axis) return `${property}: ${value}px;`;
  if (axis === "x") return `${property}-left: ${value}px; ${property}-right: ${value}px;`;
  if (axis === "y") return `${property}-top: ${value}px; ${property}-bottom: ${value}px;`;
  const sideMap: Record<string, string> = { t: "top", r: "right", b: "bottom", l: "left" };
  return `${property}-${sideMap[axis]}: ${value}px;`;
}

function escapeCssClass(className: string): string {
  return className.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
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
  const normalizedSelector = normalizeCssSelector(selector);
  if (selectors.classes.some((className) => normalizedSelector.includes(`.${normalizeCssSelector(className)}`))) return true;
  if (selectors.ids.some((id) => normalizedSelector.includes(`#${normalizeCssSelector(id)}`))) return true;
  return selectors.tags.some((tag) => new RegExp(`(^|[\\s>+~,(])${tag}([\\s.#:[>+~),]|$)`, "i").test(selector));
}

function normalizeCssSelector(value: string): string {
  return value.toLowerCase().replace(/\\/g, "");
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

function componentSortScore(candidate: ProductionComponentCandidate): number {
  let score = candidate.confidence;
  const file = (candidate.sourceFile || "").toLowerCase();
  const rootTag = candidate.html.match(/^\s*<([a-z][a-z0-9-]*)\b/i)?.[1]?.toLowerCase() || "";
  score += Math.min(10, (candidate.html.match(/<([a-z][a-z0-9-]*)\b/gi) || []).length);
  if (/^(span|em|strong|small|label|svg|path|i)$/.test(rootTag)) score -= 12;
  if (isComponentFile(file)) score += 18;
  if (/\/src\/components?\//.test(file)) score += 18;
  if (/\/playground\//.test(file)) score -= 18;
  if (/(^|\/)index\.html?$/.test(file)) score -= 24;
  if (/\/icons?\//.test(file) && /(^|\/)index\.html?$/.test(file)) score -= 18;
  return score;
}

function scoreHtmlElement(element: Element): number {
  return scoreHtmlSignals({
    tagName: element.tagName.toLowerCase(),
    id: element.id,
    classNames: Array.from(element.classList),
    attributes: attributesFromElement(element),
    text: element.textContent || "",
    descendantCount: element.querySelectorAll("*").length,
    directChildSignatures: Array.from(element.children).map(childSignature),
    html: element.outerHTML
  });
}

function scoreHtmlSignals(input: {
  tagName: string;
  id: string;
  classNames: string[];
  attributes: Record<string, string>;
  text: string;
  descendantCount: number;
  directChildSignatures: string[];
  html: string;
}): number {
  const text = input.text.replace(/\s+/g, " ").trim();
  const classText = input.classNames.join(" ");
  const nameText = `${input.id} ${classText} ${input.attributes["data-component"] || ""} ${input.attributes["aria-label"] || ""}`.toLowerCase();
  const repeatedChildren = maxDuplicate(input.directChildSignatures);
  const hasPersianText = RTL_TEXT_PATTERN.test(text);
  const hasFinancialText = FINANCIAL_TEXT_PATTERN.test(text);
  const hasTablePattern = /^(table|tbody|thead|tr|ul|ol)$/.test(input.tagName) || /\b(table|list|grid|row|card|market|ticker|symbol|price|change|percent|filter|tab)\b/i.test(`${nameText} ${input.html}`);
  const meaningfulClasses = input.classNames.filter((className) => !isGenericClassName(className));
  const genericWrapper = isGenericWrapper(input.id, input.classNames, input.descendantCount, text);
  const tinyControl = isTinyControl(input.tagName, input.descendantCount, text) && !meaningfulClasses.length;

  let score = 0;
  if (input.attributes["data-component"]) score += 30;
  if (input.attributes["aria-label"]) score += 10;
  if (input.id && !/^(app|root|main)$/i.test(input.id)) score += 14;
  if (meaningfulClasses.length) score += Math.min(18, meaningfulClasses.length * 5);
  if (input.attributes.role) score += 8;
  if (/^(section|article|main|aside|table|ul|ol|form|nav)$/.test(input.tagName)) score += 8;
  if (text.length) score += Math.min(22, 8 + Math.floor(text.length / 32));
  if (hasPersianText) score += 18;
  if (hasFinancialText) score += 8;
  if (hasTablePattern) score += 18;
  if (repeatedChildren >= 3) score += 18;
  else if (repeatedChildren === 2) score += 8;
  if (input.descendantCount > 0) score += 6;
  score += Math.min(22, input.descendantCount * 2);

  if (genericWrapper) score -= 44;
  if (tinyControl) score -= 26;
  if (/^(span|em|strong|small|label)$/.test(input.tagName) && input.descendantCount === 0) score -= 12;
  if (/^(svg|path|img|use)$/.test(input.tagName)) score -= 35;
  if (input.descendantCount > 80 && !hasTablePattern && !input.attributes["data-component"]) score -= 14;

  return score;
}

function confidenceFromElementScore(score: number): number {
  return Math.max(18, Math.min(94, Math.round(40 + score * 0.75)));
}

function dedupeDomElements(elements: Element[]): Element[] {
  const seen = new Set<string>();
  return elements.filter((element) => {
    const key = `${element.tagName}:${element.id}:${Array.from(element.classList).join(".")}:${(element.textContent || "").slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function selectDiverseHtmlCandidates<T extends { html: string; score: number }>(candidates: T[], limit: number): T[] {
  const selected: T[] = [];
  for (const candidate of candidates) {
    const normalized = candidate.html.replace(/\s+/g, " ").trim();
    const isDuplicate = selected.some((item) => {
      const existing = item.html.replace(/\s+/g, " ").trim();
      return existing === normalized || existing.includes(normalized) && normalized.length < 240;
    });
    if (isDuplicate) continue;
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function attributesFromElement(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes)) {
    attributes[attribute.name] = attribute.value;
  }
  return attributes;
}

function childSignature(element: Element): string {
  const className = Array.from(element.classList).find((item) => !isGenericClassName(item)) || Array.from(element.classList)[0] || "";
  return `${element.tagName.toLowerCase()}.${className}`;
}

function isGenericWrapper(id: string, classNames: string[], descendantCount: number, text: string): boolean {
  if (descendantCount < 8) return false;
  const allNames = [id, ...classNames].filter(Boolean);
  if (!allNames.length) return descendantCount > 18 && text.length > 120;
  const genericNames = allNames.filter(isGenericClassName);
  return genericNames.length === allNames.length && !RTL_TEXT_PATTERN.test(allNames.join(" "));
}

function isTinyControl(tagName: string, descendantCount: number, text: string): boolean {
  return /^(button|a|span|svg|i)$/.test(tagName) && descendantCount <= 4 && text.trim().length < 32;
}

function isGenericClassName(value: string): boolean {
  return /^(app|root|layout|wrapper|container|content|main|page|screen|flex|grid|row|col|relative|absolute|block|inline|hidden|items-|justify-|gap-|p[trblxy]?-|m[trblxy]?-|w-|h-|min-|max-|text-|bg-|border-|rounded-|shadow-|overflow-|font-|leading-)/i.test(value);
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
    .replace(/<\/?(iframe|object|embed|link|meta|base)[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^"'\s>]+/gi, "")
    .replace(/\ssrcdoc\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\sjavascript:/gi, "");
}

function truncatePreviewHtml(html: string): string {
  return stripUnsafeMarkup(html).trim().slice(0, MAX_PREVIEW_CHARS);
}

function truncatePreviewCss(css: string): string {
  return sanitizeCss(css).trim().slice(0, MAX_PREVIEW_CHARS);
}

function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]+;/gi, "")
    .replace(/url\(\s*["']?https?:\/\/[^)]*\)/gi, "url(about:blank)")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/javascript:/gi, "");
}

function extractHtmlFallback(html: string, fileName: string): Array<{ name: string; html: string; confidence: number }> {
  const elements = readElementCandidates(html);
  if (!elements.length) {
    return [{
      name: humanizeName(fileName),
      html,
      confidence: /<\/?[a-z][\s\S]*>/i.test(html) ? 48 : 18
    }];
  }

  const scored = elements
    .map((element) => ({ ...element, score: scoreHtmlSignals(element) }))
    .filter((element) => element.score >= 24)
    .sort((left, right) => right.score - left.score);

  const selected = selectDiverseHtmlCandidates(scored.length ? scored : elements.map((element) => ({ ...element, score: 18 })), 8);
  return selected.map((element) => ({
    name: humanizeName(element.attributes["data-component"] || element.attributes["aria-label"] || element.id || element.classNames[0] || fileName),
    html: element.html,
    confidence: confidenceFromElementScore(element.score)
  }));
}

function readElementCandidates(html: string): Array<{
  tagName: string;
  id: string;
  classNames: string[];
  attributes: Record<string, string>;
  text: string;
  descendantCount: number;
  directChildSignatures: string[];
  html: string;
}> {
  const candidates: Array<{
    tagName: string;
    id: string;
    classNames: string[];
    attributes: Record<string, string>;
    text: string;
    descendantCount: number;
    directChildSignatures: string[];
    html: string;
  }> = [];
  const tagPattern = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi;
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const stack: Array<{ tagName: string; start: number; attrs: string; childSignatures: string[] }> = [];
  let match: RegExpExecArray | null;

  while ((match = tagPattern.exec(html))) {
    const full = match[0];
    const tag = match[1].toLowerCase();
    const isClosing = full.startsWith("</");
    const isSelfClosing = full.endsWith("/>") || voidTags.has(tag);

    if (!isClosing) {
      const attrs = full.replace(/^<[a-z][a-z0-9-]*/i, "").replace(/\/?>$/, "");
      const attributes = parseAttributes(attrs);
      const signature = `${tag}.${firstMeaningfulClass(attributes.class || "")}`;
      stack[stack.length - 1]?.childSignatures.push(signature);
      if (isSelfClosing) {
        candidates.push(makeFallbackCandidate(tag, attributes, "", full, []));
      } else {
        stack.push({ tagName: tag, start: match.index, attrs, childSignatures: [] });
      }
      continue;
    }

    const openIndex = findLastOpenTag(stack, tag);
    if (openIndex < 0) continue;
    const [open] = stack.splice(openIndex, 1);
    const snippet = stripUnsafeMarkup(html.slice(open.start, tagPattern.lastIndex));
    const attributes = parseAttributes(open.attrs);
    const text = snippet.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const descendantCount = Math.max(0, (snippet.match(/<([a-z][a-z0-9-]*)\b/gi) || []).length - 1);
    candidates.push(makeFallbackCandidate(open.tagName, attributes, text, snippet, open.childSignatures, descendantCount));
  }

  return candidates.filter((candidate) => candidate.html.trim());
}

function makeFallbackCandidate(
  tagName: string,
  attributes: Record<string, string>,
  text: string,
  html: string,
  directChildSignatures: string[],
  descendantCount = 0
) {
  const classNames = (attributes.class || "").split(/\s+/).filter(Boolean);
  return {
    tagName,
    id: attributes.id || "",
    classNames,
    attributes,
    text,
    descendantCount,
    directChildSignatures,
    html
  };
}

function parseAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([:@a-zA-Z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1]] = match[2] || match[3] || match[4] || "";
  }
  return attributes;
}

function findLastOpenTag(stack: Array<{ tagName: string }>, tagName: string): number {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index].tagName === tagName) return index;
  }
  return -1;
}

function firstMeaningfulClass(value: string): string {
  return value.split(/\s+/).find((className) => !isGenericClassName(className)) || value.split(/\s+/).find(Boolean) || "";
}

function maxDuplicate(values: string[]): number {
  const counts = new Map<string, number>();
  let max = 0;
  for (const value of values.filter(Boolean)) {
    const next = (counts.get(value) || 0) + 1;
    counts.set(value, next);
    max = Math.max(max, next);
  }
  return max;
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

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractTopLevelColorLiterals(text: string): Array<[string, string]> {
  const literals: Array<[string, string]> = [];
  for (const match of text.matchAll(JS_COLOR_LITERAL_PATTERN)) {
    const before = text.slice(0, match.index);
    if (braceDepth(before) > 1) continue;
    literals.push([match[1], cleanValue(match[2])]);
  }
  return literals;
}

function readSimpleObjectBlocks(text: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  const pattern = /([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    const bodyStart = pattern.lastIndex;
    const bodyEnd = findMatchingBrace(text, bodyStart - 1);
    if (bodyEnd <= bodyStart) continue;
    const body = text.slice(bodyStart, bodyEnd);
    if (!body.includes("#") && !/rgba?\(/i.test(body) && !/transparent|black|white/i.test(body)) continue;
    blocks.push({ name: match[1], body });
    pattern.lastIndex = bodyEnd + 1;
  }

  return blocks;
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let quote: string | null = null;

  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function braceDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const previous = text[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth = Math.max(0, depth - 1);
  }
  return depth;
}
