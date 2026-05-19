export type SourceInputKind = "html-css" | "production-file" | "repo-upload" | "github";

export type TokenCategory = "color" | "typography" | "spacing" | "radius" | "effect";

export type TokenValue = string | number;

export interface SourceTextFile {
  name: string;
  size: number;
  text: string;
}

export interface ProductionToken {
  id: string;
  name: string;
  displayName: string;
  category: TokenCategory;
  value: TokenValue;
  rawValue: string;
  sourceFile?: string;
  cssProperty?: string;
}

export interface SourceSummary {
  fileCount: number;
  totalBytes: number;
  colors: number;
  typography: number;
  spacing: number;
  radius: number;
  effects: number;
}

export interface ProductionComponentCandidate {
  id: string;
  name: string;
  sourceLabel: string;
  sourceFile?: string;
  inputKind: SourceInputKind;
  confidence: number;
  html: string;
  css: string;
  summary: string;
  reason: string;
  tokenIds: string[];
}

export interface ProductionReference {
  label: string;
  inputKind: SourceInputKind;
  tokens: ProductionToken[];
  sourceSummary: SourceSummary;
  components: ProductionComponentCandidate[];
  selectedComponentId?: string;
}

export interface SelectedFigmaComponent {
  nodeId: string | null;
  name: string;
  type: string;
  width: number;
  height: number;
  hasSelection: boolean;
  styleSummary: string;
}

export type LayerTokenField =
  | "fill"
  | "stroke"
  | "text-style"
  | "font-family"
  | "font-size"
  | "font-weight"
  | "line-height"
  | "corner-radius"
  | "top-left-radius"
  | "top-right-radius"
  | "bottom-right-radius"
  | "bottom-left-radius"
  | "gap"
  | "padding-left"
  | "padding-right"
  | "padding-top"
  | "padding-bottom"
  | "effect";

export interface LayerToken {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  nodePath: string;
  field: LayerTokenField;
  category: TokenCategory;
  value: TokenValue;
  displayValue: string;
  figmaStyleName?: string;
  figmaVariableName?: string;
  hasStyleBinding: boolean;
  hasVariableBinding: boolean;
}

export interface ScannedLayer {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  nodePath: string;
  visible: boolean;
  width: number;
  height: number;
  hasVisibleFill: boolean;
  hasVisibleStroke: boolean;
  hasVisibleEffect: boolean;
  hasFillStyle: boolean;
  hasStrokeStyle: boolean;
  hasTextStyle: boolean;
  hasEffectStyle: boolean;
  hasFillVariable: boolean;
  hasStrokeVariable: boolean;
  hasEffectVariable: boolean;
  tokens: LayerToken[];
}

export type IssueSeverity = "error" | "warning";

export type IssueGroup = "Missing styles" | "Color" | "Typography" | "Spacing" | "Border radius" | "Effects";

export interface LintIssue {
  id: string;
  issueType: string;
  group: IssueGroup;
  severity: IssueSeverity;
  nodeId: string;
  nodeName: string;
  nodePath: string;
  field: LayerTokenField;
  message: string;
  actual: string;
  expected: string;
  suggestedFix: string;
  annotation: string;
}

export interface ScanReport {
  sourceLabel: string;
  scannedLayers: number;
  summary: Record<IssueGroup, number>;
  issues: LintIssue[];
}

export type UiToControllerMessage =
  | { type: "scan"; reference: ProductionReference | null; annotate: boolean; includeDesignLint: boolean }
  | { type: "inspect-selection" }
  | { type: "select-node"; nodeId: string }
  | { type: "clear-annotations" };

export type ControllerToUiMessage =
  | { type: "progress"; message: string }
  | { type: "scan-complete"; report: ScanReport }
  | { type: "error"; message: string }
  | { type: "selection-info"; component: SelectedFigmaComponent }
  | { type: "annotations-cleared" };
