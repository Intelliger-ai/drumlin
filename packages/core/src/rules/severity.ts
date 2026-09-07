import { severityRank, type Finding } from "@drumlin/model";

/**
 * Ranking findings.
 *
 * Source 05 defines impact as task criticality times frequency times failure
 * cost times affected users. Milestone A has none of those inputs — they come
 * from confirmed context and runtime evidence, neither of which exists yet.
 * Rather than invent them and produce a precise-looking number that is mostly
 * made up, priority here is just severity weighted by confidence.
 */
export function priorityOf(finding: Finding): number {
  return (severityRank(finding.severity) + 1) * finding.confidence;
}

/** Highest priority first, then stable by rule and target for diffability. */
export function compareFindings(a: Finding, b: Finding): number {
  const byPriority = priorityOf(b) - priorityOf(a);
  if (Math.abs(byPriority) > 1e-9) return byPriority;
  return (
    a.ruleId.localeCompare(b.ruleId) ||
    (a.target.node ?? a.target.route ?? a.target.file ?? "").localeCompare(
      b.target.node ?? b.target.route ?? b.target.file ?? "",
    )
  );
}
