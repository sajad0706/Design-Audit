import type { IssueGroup, LintIssue, ScanReport } from "../../shared/types";
import { Tooltip } from "./Tooltip";

interface ResultsPanelProps {
  report: ScanReport | null;
  onSelectNode: (nodeId: string) => void;
}

const GROUPS: IssueGroup[] = ["Missing styles", "Color", "Typography", "Spacing", "Border radius", "Effects"];
const GROUP_PREVIEW_LIMIT = 4;

interface IssueCluster {
  id: string;
  group: IssueGroup;
  representative: LintIssue;
  issues: LintIssue[];
  severity: LintIssue["severity"];
}

export function ResultsPanel({ report, onSelectNode }: ResultsPanelProps) {
  if (!report) {
    return (
      <section className="panel empty-panel">
        <div className="panel-title">
          <h2>Results</h2>
          <Tooltip label="Click any annotation to jump to the issue" />
        </div>
        <p className="muted">Run a scan to see audit issues.</p>
      </section>
    );
  }

  const clusters = clusterIssues(report.issues);

  return (
    <section className="panel results-panel">
      <div className="panel-title">
        <h2>Results</h2>
        <Tooltip label="Click any annotation to jump to the issue" />
      </div>

      <div className="summary-grid">
        <Metric label="Layers" value={report.scannedLayers} />
        <Metric label="Issues" value={report.issues.length} />
        <Metric label="Source" value={report.sourceLabel} compact />
      </div>

      {report.issues.length === 0 ? (
        <div className="success-box">
          <strong>No mismatches found</strong>
          <span>Ready for developer handoff.</span>
        </div>
      ) : (
        <div className="issue-groups">
          {GROUPS.map((group) => {
            const issues = report.issues.filter((issue) => issue.group === group);
            const groupClusters = clusters.filter((cluster) => cluster.group === group);
            if (!groupClusters.length) return null;
            return (
              <section className="issue-group" key={group}>
                <header>
                  <h3>{group}</h3>
                  <span>{groupClusters.length} patterns / {issues.length} layers</span>
                </header>
                <div className="issue-list">
                  {groupClusters.slice(0, GROUP_PREVIEW_LIMIT).map((cluster) => (
                    <button className="issue-row" key={cluster.id} onClick={() => onSelectNode(cluster.representative.nodeId)} type="button">
                      <IssueCopy cluster={cluster} />
                    </button>
                  ))}
                  {groupClusters.length > GROUP_PREVIEW_LIMIT && (
                    <div className="more-row">+{groupClusters.length - GROUP_PREVIEW_LIMIT} more patterns in this group. Representative pins are shown on canvas.</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function IssueCopy({ cluster }: { cluster: IssueCluster }) {
  const issue = cluster.representative;
  const layerNames = cluster.issues.map((item) => item.nodeName);
  return (
    <>
      <span className={`severity severity-${cluster.severity}`}>{cluster.severity}</span>
      <span className="issue-main">
        <strong>{issue.issueType}</strong>
        <small>{cluster.issues.length} layer{cluster.issues.length === 1 ? "" : "s"} · {layerNames.slice(0, 3).join(", ")}</small>
        <span>{issue.annotation}</span>
        <em>{issue.suggestedFix}</em>
      </span>
    </>
  );
}

function clusterIssues(issues: LintIssue[]): IssueCluster[] {
  const clusters = new Map<string, IssueCluster>();

  for (const issue of issues) {
    const key = [issue.group, issue.issueType, issue.expected, issue.actual].join("::");
    const existing = clusters.get(key);
    if (existing) {
      existing.issues.push(issue);
      if (issue.severity === "error") existing.severity = "error";
      continue;
    }

    clusters.set(key, {
      id: key,
      group: issue.group,
      representative: issue,
      issues: [issue],
      severity: issue.severity
    });
  }

  return Array.from(clusters.values());
}

function Metric({ label, value, compact = false }: { label: string; value: number | string; compact?: boolean }) {
  return (
    <div className={compact ? "metric metric-compact" : "metric"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
