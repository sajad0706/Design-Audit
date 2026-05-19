import type { LintIssue, ScannedLayer } from "../shared/types";

const PLUGIN_MARKER_KEY = "production-code-audit-marker";
const PLUGIN_ANNOTATION_PREFIX = "[Design Audit]";
const LEGACY_ANNOTATION_PREFIX = "[Production Code Audit]";
const MAX_NODE_ANNOTATIONS = 5;
const MAX_ISSUES_PER_GROUP = 1;

// Removes previous audit annotations and canvas labels made by this plugin.
export async function clearAuditAnnotations(layers: ScannedLayer[] = []): Promise<void> {
  for (const marker of figma.currentPage.findAll((node) => node.getPluginData(PLUGIN_MARKER_KEY) === "1")) {
    marker.remove();
  }

  if (layers.length) {
    for (const layer of layers) {
      const node = await getNode(layer.nodeId);
      if (node) removeNodeAnnotations(node);
    }
    return;
  }

  for (const node of figma.currentPage.findAll()) {
    removeNodeAnnotations(node);
  }
}

// Adds direct Figma annotations and compact canvas labels for the highest priority issues.
export async function annotateIssues(issues: LintIssue[], layers: ScannedLayer[]): Promise<void> {
  await clearAuditAnnotations();

  const representativeIssues = selectRepresentativeIssues(issues);
  const byNode = groupIssuesByNode(representativeIssues);

  for (const [nodeId, nodeIssues] of byNode) {
    const node = await getNode(nodeId);
    if (!node) continue;
    writeNodeAnnotation(node, nodeIssues);
  }

  await createCanvasDigest(issues, representativeIssues, layers);
}

function writeNodeAnnotation(node: SceneNode, issues: LintIssue[]): void {
  if (!("annotations" in node)) return;
  const current = Array.isArray((node as SceneNode & { annotations?: Array<{ labelMarkdown: string }> }).annotations)
    ? ((node as SceneNode & { annotations?: Array<{ labelMarkdown: string }> }).annotations || [])
    : [];
  const retained = current.filter((annotation) => !isPluginAnnotation(annotation.labelMarkdown));
  const body = issues.slice(0, 3).map((issue) => issue.annotation).join("\n\n");
  (node as SceneNode & { annotations?: Array<{ labelMarkdown: string }> }).annotations = retained.concat({
    labelMarkdown: `${PLUGIN_ANNOTATION_PREFIX}\n${body}`
  });
}

function removeNodeAnnotations(node: SceneNode): void {
  if (!("annotations" in node)) return;
  const target = node as SceneNode & { annotations?: Array<{ labelMarkdown: string }> };
  if (!Array.isArray(target.annotations)) return;
  target.annotations = target.annotations.filter((annotation) => !isPluginAnnotation(annotation.labelMarkdown));
}

async function createCanvasDigest(issues: LintIssue[], pinnedIssues: LintIssue[], layers: ScannedLayer[]): Promise<void> {
  if (!issues.length) return;
  await loadAnnotationFont();

  const anchor = await findDigestAnchor(layers);
  if (!anchor) return;

  const marker = figma.createFrame();
  marker.name = "Design audit - summary";
  marker.setPluginData(PLUGIN_MARKER_KEY, "1");
  marker.cornerRadius = 8;
  marker.fills = [{ type: "SOLID", color: { r: 0.08, g: 0.08, b: 0.09 } }];
  marker.strokes = [{ type: "SOLID", color: { r: 0.94, g: 0.16, b: 0.16 }, opacity: 0.85 }];
  marker.strokeWeight = 1;
  marker.resize(280, 128);
  marker.x = anchor.x + anchor.width + 18;
  marker.y = anchor.y;

  const title = figma.createText();
  title.fontName = { family: "Inter", style: "Bold" };
  title.characters = "Design Audit";
  title.fontSize = 12;
  title.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  title.x = 12;
  title.y = 10;
  title.resize(256, 16);
  marker.appendChild(title);

  const body = figma.createText();
  body.fontName = { family: "Inter", style: "Regular" };
  body.characters = buildDigestText(issues, pinnedIssues);
  body.fontSize = 10;
  body.lineHeight = { unit: "PIXELS", value: 14 };
  body.fills = [{ type: "SOLID", color: { r: 0.92, g: 0.92, b: 0.94 } }];
  body.x = 12;
  body.y = 32;
  body.resize(256, 84);
  marker.appendChild(body);

  figma.currentPage.appendChild(marker);
}

function selectRepresentativeIssues(issues: LintIssue[]): LintIssue[] {
  const selected: LintIssue[] = [];
  const byGroup = new Map<string, number>();
  const seenNodes = new Set<string>();

  for (const issue of issues) {
    if (selected.length >= MAX_NODE_ANNOTATIONS) break;
    const groupCount = byGroup.get(issue.group) || 0;
    if (groupCount >= MAX_ISSUES_PER_GROUP) continue;
    if (seenNodes.has(issue.nodeId)) continue;

    selected.push(issue);
    seenNodes.add(issue.nodeId);
    byGroup.set(issue.group, groupCount + 1);
  }

  return selected;
}

function buildDigestText(issues: LintIssue[], pinnedIssues: LintIssue[]): string {
  const groups = ["Missing styles", "Color", "Typography", "Spacing", "Border radius", "Effects"];
  const lines = groups
    .map((group) => [group, issues.filter((issue) => issue.group === group).length] as const)
    .filter(([, count]) => count > 0)
    .slice(0, 5)
    .map(([group, count]) => `${group}: ${count}`);

  return [
    `${issues.length} issues found.`,
    `${pinnedIssues.length} representative layer pins shown.`,
    ...lines,
    "Open the panel for the full list."
  ].join("\n");
}

function isPluginAnnotation(label: string): boolean {
  return label.startsWith(PLUGIN_ANNOTATION_PREFIX) || label.startsWith(LEGACY_ANNOTATION_PREFIX);
}

async function findDigestAnchor(layers: ScannedLayer[]): Promise<{ x: number; y: number; width: number; height: number } | null> {
  for (const layer of layers) {
    const node = await getNode(layer.nodeId);
    if (node && "absoluteBoundingBox" in node && node.absoluteBoundingBox) return node.absoluteBoundingBox;
  }
  return null;
}

function groupIssuesByNode(issues: LintIssue[]): Map<string, LintIssue[]> {
  const byNode = new Map<string, LintIssue[]>();
  for (const issue of issues) {
    byNode.set(issue.nodeId, [...(byNode.get(issue.nodeId) || []), issue]);
  }
  return byNode;
}

async function getNode(nodeId: string): Promise<SceneNode | null> {
  const node = figma.getNodeByIdAsync ? await figma.getNodeByIdAsync(nodeId) : figma.getNodeById(nodeId);
  return node && node.type !== "PAGE" && node.type !== "DOCUMENT" ? (node as SceneNode) : null;
}

async function loadAnnotationFont(): Promise<void> {
  try {
    await Promise.all([
      figma.loadFontAsync({ family: "Inter", style: "Regular" }),
      figma.loadFontAsync({ family: "Inter", style: "Bold" })
    ]);
  } catch {
    figma.notify("Could not load Inter for canvas labels. Layer annotations were still added.");
  }
}
