import type { LayerToken, ScannedLayer, TokenCategory, TokenValue } from "../shared/types";
import { formatTokenValue, rgbToHex } from "../shared/tokenUtils";

const MAX_SCANNED_LAYERS = 1800;

type NodeWithChildren = SceneNode & ChildrenMixin;
type RuntimeNode = SceneNode & Record<string, unknown>;

interface BindingInfo {
  name?: string;
  hasBinding: boolean;
}

// Reads the current selection when present, otherwise scans the current page.
export async function scanFigmaLayers(): Promise<ScannedLayer[]> {
  figma.skipInvisibleInstanceChildren = true;
  const roots = figma.currentPage.selection.length ? Array.from(figma.currentPage.selection) : Array.from(figma.currentPage.children);
  const nodes = flattenNodes(roots);
  const scanned: ScannedLayer[] = [];

  for (const node of nodes) {
    scanned.push(await describeLayer(node));
  }

  return scanned.filter((layer) => layer.visible);
}

function flattenNodes(roots: readonly SceneNode[]): SceneNode[] {
  const nodes: SceneNode[] = [];
  const queue = [...roots];

  while (queue.length) {
    if (nodes.length >= MAX_SCANNED_LAYERS) throw new Error(`This selection has more than ${MAX_SCANNED_LAYERS} layers. Scan a smaller section.`);
    const node = queue.shift();
    if (!node) continue;
    nodes.push(node);
    if ("children" in node) queue.push(...Array.from((node as NodeWithChildren).children));
  }

  return nodes;
}

// Converts a Figma node into serializable lint data and token candidates.
async function describeLayer(node: SceneNode): Promise<ScannedLayer> {
  const nodePath = getNodePath(node);
  const fillBinding = await getBindingInfo(node, "fills");
  const strokeBinding = await getBindingInfo(node, "strokes");
  const effectBinding = await getBindingInfo(node, "effects");
  const tokens: LayerToken[] = [];

  await pushPaintToken(tokens, node, nodePath, "fill", "fills", fillBinding);
  await pushPaintToken(tokens, node, nodePath, "stroke", "strokes", strokeBinding);
  await pushTextTokens(tokens, node, nodePath);
  await pushRadiusTokens(tokens, node, nodePath);
  await pushSpacingTokens(tokens, node, nodePath);
  await pushEffectToken(tokens, node, nodePath, effectBinding);

  return {
    nodeId: node.id,
    nodeName: node.name || node.type,
    nodeType: node.type,
    nodePath,
    visible: "visible" in node ? node.visible !== false : true,
    width: "width" in node && typeof node.width === "number" ? node.width : 0,
    height: "height" in node && typeof node.height === "number" ? node.height : 0,
    hasVisibleFill: hasVisiblePaint((node as RuntimeNode).fills),
    hasVisibleStroke: hasVisiblePaint((node as RuntimeNode).strokes),
    hasVisibleEffect: hasVisibleEffect((node as RuntimeNode).effects),
    hasFillStyle: hasStyleId((node as RuntimeNode).fillStyleId),
    hasStrokeStyle: hasStyleId((node as RuntimeNode).strokeStyleId),
    hasTextStyle: node.type === "TEXT" && hasStyleId(node.textStyleId),
    hasEffectStyle: hasStyleId((node as RuntimeNode).effectStyleId),
    hasFillVariable: fillBinding.hasBinding,
    hasStrokeVariable: strokeBinding.hasBinding,
    hasEffectVariable: effectBinding.hasBinding,
    tokens
  };
}

async function pushPaintToken(
  tokens: LayerToken[],
  node: SceneNode,
  nodePath: string,
  field: "fill" | "stroke",
  property: "fills" | "strokes",
  binding: BindingInfo
): Promise<void> {
  const runtimeNode = node as RuntimeNode;
  const paints = runtimeNode[property];
  if (!Array.isArray(paints)) return;
  const color = firstSolidColor(paints as readonly Paint[]);
  if (!color) return;
  const styleName = await getStyleName(field === "fill" ? runtimeNode.fillStyleId : runtimeNode.strokeStyleId);
  tokens.push(makeLayerToken(node, nodePath, field, "color", color, {
    styleName,
    variableName: binding.name,
    hasStyleBinding: Boolean(styleName),
    hasVariableBinding: binding.hasBinding
  }));
}

async function pushTextTokens(tokens: LayerToken[], node: SceneNode, nodePath: string): Promise<void> {
  if (node.type !== "TEXT") return;
  const styleName = await getStyleName(node.textStyleId);
  const fontBinding = await getBindingInfo(node, "fontSize");
  const fontName = node.fontName !== figma.mixed ? node.fontName : null;

  if (fontName?.family) {
    tokens.push(makeLayerToken(node, nodePath, "font-family", "typography", fontName.family, {
      styleName,
      hasStyleBinding: Boolean(styleName),
      hasVariableBinding: false
    }));
  }

  if (typeof node.fontSize === "number") {
    tokens.push(makeLayerToken(node, nodePath, "font-size", "typography", node.fontSize, {
      styleName,
      variableName: fontBinding.name,
      hasStyleBinding: Boolean(styleName),
      hasVariableBinding: fontBinding.hasBinding
    }));
  }

  if (fontName?.style) {
    const fontWeight = inferFontWeight(fontName.style);
    const fontWeightBinding = await getBindingInfo(node, "fontWeight");
    tokens.push(makeLayerToken(node, nodePath, "font-weight", "typography", fontWeight, {
      styleName,
      variableName: fontWeightBinding.name,
      hasStyleBinding: Boolean(styleName),
      hasVariableBinding: fontWeightBinding.hasBinding
    }));
  }

  const lineHeight = normalizeLineHeight(node.lineHeight);
  if (lineHeight != null) {
    const lineHeightBinding = await getBindingInfo(node, "lineHeight");
    tokens.push(makeLayerToken(node, nodePath, "line-height", "typography", lineHeight, {
      styleName,
      variableName: lineHeightBinding.name,
      hasStyleBinding: Boolean(styleName),
      hasVariableBinding: lineHeightBinding.hasBinding
    }));
  }
}

async function pushRadiusTokens(tokens: LayerToken[], node: SceneNode, nodePath: string): Promise<void> {
  const radiusFields: Array<[string, LayerToken["field"]]> = [
    ["cornerRadius", "corner-radius"],
    ["topLeftRadius", "top-left-radius"],
    ["topRightRadius", "top-right-radius"],
    ["bottomRightRadius", "bottom-right-radius"],
    ["bottomLeftRadius", "bottom-left-radius"]
  ];

  for (const [property, field] of radiusFields) {
    const value = (node as RuntimeNode)[property];
    if (value === figma.mixed || typeof value !== "number") continue;
    const binding = await getBindingInfo(node, property);
    tokens.push(makeLayerToken(node, nodePath, field, "radius", value, {
      variableName: binding.name,
      hasStyleBinding: false,
      hasVariableBinding: binding.hasBinding
    }));
  }
}

async function pushSpacingTokens(tokens: LayerToken[], node: SceneNode, nodePath: string): Promise<void> {
  const spacingFields: Array<[string, LayerToken["field"]]> = [
    ["itemSpacing", "gap"],
    ["paddingLeft", "padding-left"],
    ["paddingRight", "padding-right"],
    ["paddingTop", "padding-top"],
    ["paddingBottom", "padding-bottom"]
  ];

  for (const [property, field] of spacingFields) {
    const value = (node as RuntimeNode)[property];
    if (typeof value !== "number") continue;
    const binding = await getBindingInfo(node, property);
    tokens.push(makeLayerToken(node, nodePath, field, "spacing", value, {
      variableName: binding.name,
      hasStyleBinding: false,
      hasVariableBinding: binding.hasBinding
    }));
  }
}

async function pushEffectToken(tokens: LayerToken[], node: SceneNode, nodePath: string, binding: BindingInfo): Promise<void> {
  const runtimeNode = node as RuntimeNode;
  const effects = runtimeNode.effects;
  if (!Array.isArray(effects)) return;
  const visibleEffects = (effects as readonly Effect[]).filter((effect) => effect.visible !== false);
  if (!visibleEffects.length) return;
  const styleName = await getStyleName(runtimeNode.effectStyleId);

  tokens.push(makeLayerToken(node, nodePath, "effect", "effect", formatEffects(visibleEffects), {
    styleName,
    variableName: binding.name,
    hasStyleBinding: Boolean(styleName),
    hasVariableBinding: binding.hasBinding
  }));
}

function makeLayerToken(
  node: SceneNode,
  nodePath: string,
  field: LayerToken["field"],
  category: TokenCategory,
  value: TokenValue,
  bindings: { styleName?: string; variableName?: string; hasStyleBinding: boolean; hasVariableBinding: boolean }
): LayerToken {
  return {
    id: `${node.id}:${field}`,
    nodeId: node.id,
    nodeName: node.name || node.type,
    nodeType: node.type,
    nodePath,
    field,
    category,
    value,
    displayValue: formatLayerTokenValue(value, category, field),
    figmaStyleName: bindings.styleName,
    figmaVariableName: bindings.variableName,
    hasStyleBinding: bindings.hasStyleBinding,
    hasVariableBinding: bindings.hasVariableBinding
  };
}

function formatLayerTokenValue(value: TokenValue, category: TokenCategory, field: LayerToken["field"]): string {
  if (field === "font-family") return String(value);
  if (field === "font-weight") return String(value);
  return formatTokenValue(value, category);
}

async function getStyleName(styleId: unknown): Promise<string | undefined> {
  if (!styleId || typeof styleId !== "string") return undefined;
  try {
    const style = figma.getStyleByIdAsync ? await figma.getStyleByIdAsync(styleId) : figma.getStyleById(styleId);
    return style?.name;
  } catch {
    return undefined;
  }
}

async function getBindingInfo(node: SceneNode, field: string | number | symbol): Promise<BindingInfo> {
  const boundVariables = "boundVariables" in node ? (node.boundVariables as Record<string, unknown> | undefined) : undefined;
  const raw = boundVariables?.[String(field)];
  const alias = Array.isArray(raw) ? raw.find(Boolean) : raw;
  const id = readVariableId(alias);
  if (!id) return { hasBinding: false };

  try {
    const variable = figma.variables.getVariableByIdAsync ? await figma.variables.getVariableByIdAsync(id) : figma.variables.getVariableById(id);
    return { hasBinding: true, name: variable?.name };
  } catch {
    return { hasBinding: true };
  }
}

function readVariableId(alias: unknown): string | null {
  if (!alias || typeof alias !== "object") return null;
  if ("id" in alias && typeof alias.id === "string") return alias.id;
  if ("variableId" in alias && typeof alias.variableId === "string") return alias.variableId;
  return null;
}

function getNodePath(node: BaseNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    parts.unshift(current.name || current.type);
    current = current.parent;
  }
  return parts.join(" / ");
}

function hasStyleId(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

function hasVisiblePaint(value: unknown): boolean {
  return Array.isArray(value) && value.some((paint) => paint && paint.visible !== false);
}

function hasVisibleEffect(value: unknown): boolean {
  return Array.isArray(value) && value.some((effect) => effect && effect.visible !== false);
}

function firstSolidColor(paints: readonly Paint[] | PluginAPI["mixed"]): string | null {
  if (!Array.isArray(paints)) return null;
  const paint = paints.find((item) => item.type === "SOLID" && item.visible !== false);
  if (!paint || paint.type !== "SOLID") return null;
  return rgbToHex(paint.color, paint.opacity ?? 1);
}

function formatEffects(effects: readonly Effect[]): string {
  return effects.map(formatEffect).join(" | ");
}

function formatEffect(effect: Effect): string {
  const radius = "radius" in effect ? effect.radius : 0;
  const base = effect.type.toLowerCase().replace(/_/g, "-");

  if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
    return `${base} ${effect.offset.x}px ${effect.offset.y}px ${radius}px ${effect.spread}px ${rgbToHex(effect.color, effect.color.a ?? 1)}`;
  }

  return `${base} ${radius}px`;
}

function normalizeLineHeight(lineHeight: TextNode["lineHeight"]): number | null {
  if (!lineHeight || lineHeight === figma.mixed || lineHeight.unit === "AUTO") return null;
  return Math.round(lineHeight.value * 100) / 100;
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
