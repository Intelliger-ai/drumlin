import type { Finding, Issue, Severity } from "@drumlin/model";
import { dim } from "./outline.js";

/**
 * Finding output.
 *
 * Written to be triaged: the product problem first, the evidence next to it,
 * and the rule name last. A reader deciding whether something is real should
 * never have to look up what a rule ID means.
 */

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  info: "info",
};

export interface FindingLine {
  finding: Finding;
  issue?: Issue;
}

/** Why the report came back empty, when the run itself was not empty. */
export interface EmptyReason {
  /** Findings the run produced before the caller's filters applied. */
  total: number;
  /** `--severity`, if one was given. */
  severity?: Severity;
  /** Findings hidden because their issue is accepted. */
  accepted: number;
}

export function renderFindings(
  entries: readonly FindingLine[],
  empty?: EmptyReason,
): string {
  if (entries.length === 0) {
    // "The rules are too narrow" is the right thing to say about an app with
    // nothing to report, and the wrong thing to say when ten findings were
    // filtered out a line ago. Blaming the rules for the caller's own floor
    // sends people reading rule source for no reason.
    if (empty && empty.total > 0) {
      // The two filters can overlap — an accepted issue may also sit below the
      // floor — so name them rather than partitioning the count between them.
      const accepted =
        empty.accepted > 0
          ? ` ${empty.accepted} of them ${
              empty.accepted === 1 ? "is an" : "are"
            } accepted deviation${empty.accepted === 1 ? "" : "s"}.`
          : "";

      if (empty.severity) {
        return `Nothing at ${empty.severity} or above. ${empty.total} finding(s) are below it.${accepted} Drop \`--severity\` to see them.`;
      }

      return `Nothing to report. All ${empty.total} finding(s) are hidden.${accepted} Pass \`--accepted\` to see them.`;
    }

    return "No findings. Either the app is in good shape or the rules are too narrow — check `drumlin graph` to see what was analyzed.";
  }

  const lines: string[] = [];

  for (const [index, entry] of entries.entries()) {
    const { finding, issue } = entry;
    if (index > 0) lines.push("");

    const id = issue ? `${issue.id}  ` : "";
    const accepted = issue?.status === "accepted" ? dim("  [accepted]") : "";
    lines.push(
      `${id}${SEVERITY_LABEL[finding.severity]}${accepted}  ${finding.message}`,
    );

    const where = locationOf(finding);
    if (where) lines.push(`    ${dim(where)}`);

    if (finding.proposal) lines.push(`    fix: ${finding.proposal}`);

    const affected = finding.evidence.filter(
      (item) => item.note === "affected screen",
    );
    if (affected.length > 0) {
      const shown = affected
        .slice(0, 6)
        .map((item) => item.ref)
        .join(", ");
      lines.push(
        `    affects: ${shown}${affected.length > 6 ? dim(` and ${affected.length - 6} more`) : ""}`,
      );
    }

    lines.push(
      `    ${dim(
        `${finding.ruleId} · ${finding.classification} · confidence ${finding.confidence.toFixed(2)}`,
      )}`,
    );
  }

  return lines.join("\n");
}

function locationOf(finding: Finding): string | undefined {
  const source = finding.evidence.find(
    (item) => item.type === "source" && item.location !== undefined,
  );
  if (source?.location) {
    const { file, line } = source.location;
    return line ? `${file}:${line}` : file;
  }
  if (finding.target.file) return finding.target.file;
  if (finding.target.route) return finding.target.route;
  if (finding.target.node) return finding.target.node;
  return undefined;
}

export function renderCounts(counts: {
  total: number;
  introduced: number;
  stillOpen: number;
  accepted: number;
  noLongerDetected: number;
}): string {
  const parts = [
    `${counts.stillOpen} open`,
    `${counts.introduced} new`,
  ];
  if (counts.accepted > 0) parts.push(`${counts.accepted} accepted`);
  if (counts.noLongerDetected > 0) {
    parts.push(`${counts.noLongerDetected} no longer detected`);
  }
  return parts.join(" · ");
}

/** Findings grouped by rule, for judging precision during triage. */
export function renderByRule(findings: readonly Finding[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    counts.set(finding.ruleId, (counts.get(finding.ruleId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ruleId, count]) => `  ${String(count).padStart(3)}  ${ruleId}`)
    .join("\n");
}
