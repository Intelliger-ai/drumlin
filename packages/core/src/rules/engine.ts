import {
  targetKey,
  type Evidence,
  type Finding,
  type NodeId,
} from "@drumlin/model";
import { commonRoutePrefix } from "../graph/reachability.js";
import { compareFindings } from "./severity.js";
import type { Rule, RuleContext } from "./types.js";

/**
 * The rule engine.
 *
 * Runs rules, then spends most of its effort on not reporting the same problem
 * twice. Precision is the goal of Milestone A, and duplicate findings damage
 * trust as effectively as wrong ones.
 */

/**
 * When both rules fire on one target, the first explains the second.
 *
 * An unreachable screen offering no way onward is not a dead-end problem; it is
 * the same reachability problem seen from the other side.
 */
const DOMINANCE: ReadonlyArray<readonly [string, string]> = [
  ["flow.orphan", "flow.dead-end"],
];

export interface RuleError {
  ruleId: string;
  message: string;
}

export interface RuleRunResult {
  findings: Finding[];
  /** Findings removed, and why. Reported so dedup stays inspectable. */
  suppressed: Array<{ finding: Finding; reason: string }>;
  /** Rules that threw. A broken rule must not fail the whole run. */
  errors: RuleError[];
  /** Count of raw findings before deduplication. */
  rawCount: number;
}

export function runRules(
  rules: readonly Rule[],
  context: RuleContext,
): RuleRunResult {
  const raw: Finding[] = [];
  const errors: RuleError[] = [];
  const suppressed: RuleRunResult["suppressed"] = [];

  for (const rule of rules) {
    try {
      raw.push(...rule.evaluate(context));
    } catch (error) {
      errors.push({
        ruleId: rule.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const rawCount = raw.length;

  // 1. Exact duplicates: same rule, same target. Keep the most confident.
  const byIdentity = new Map<string, Finding>();
  for (const finding of raw) {
    const key = `${finding.ruleId}|${targetKey(finding.target)}`;
    const existing = byIdentity.get(key);
    if (!existing) {
      byIdentity.set(key, finding);
      continue;
    }
    if (finding.confidence > existing.confidence) {
      byIdentity.set(key, finding);
      suppressed.push({ finding: existing, reason: "duplicate target" });
    } else {
      suppressed.push({ finding, reason: "duplicate target" });
    }
  }

  // 2. Root cause: drop findings whose cause is already reported elsewhere.
  let findings = [...byIdentity.values()];
  const targetsByRule = new Map<string, Set<string>>();
  for (const finding of findings) {
    const bucket = targetsByRule.get(finding.ruleId) ?? new Set<string>();
    bucket.add(targetKey(finding.target));
    targetsByRule.set(finding.ruleId, bucket);
  }

  findings = findings.filter((finding) => {
    for (const [dominant, dominated] of DOMINANCE) {
      if (finding.ruleId !== dominated) continue;
      if (targetsByRule.get(dominant)?.has(targetKey(finding.target))) {
        suppressed.push({
          finding,
          reason: `explained by ${dominant}`,
        });
        return false;
      }
    }
    return true;
  });

  // 3. Shared fix: collapse a rule's findings that one change would resolve.
  const grouped: Finding[] = [];
  const byRule = new Map<string, Finding[]>();
  for (const finding of findings) {
    const bucket = byRule.get(finding.ruleId) ?? [];
    bucket.push(finding);
    byRule.set(finding.ruleId, bucket);
  }

  for (const [ruleId, bucket] of byRule) {
    const rule = rules.find((candidate) => candidate.id === ruleId);
    const grouping = rule?.group;

    if (!grouping || bucket.length < grouping.minMembers) {
      grouped.push(...bucket);
      continue;
    }

    for (const cluster of clusterByRoutePrefix(bucket, grouping.minMembers)) {
      if (cluster.findings.length < grouping.minMembers) {
        grouped.push(...cluster.findings);
        continue;
      }
      grouped.push(
        mergeCluster(cluster.findings, cluster.prefix, grouping),
      );
      for (const finding of cluster.findings) {
        suppressed.push({
          finding,
          reason: `grouped under ${cluster.prefix}`,
        });
      }
    }
  }

  return {
    findings: grouped.sort(compareFindings),
    suppressed,
    errors,
    rawCount,
  };
}

interface Cluster {
  prefix: string;
  findings: Finding[];
}

/**
 * Group findings by the section of the app they sit in.
 *
 * Clusters on the first route segment, which is where a shared layout — and
 * therefore a shared fix — usually lives. Findings without a route stay
 * ungrouped, since there is nothing to share.
 */
function clusterByRoutePrefix(
  findings: readonly Finding[],
  minMembers: number,
): Cluster[] {
  const bySection = new Map<string, Finding[]>();
  const ungrouped: Finding[] = [];

  for (const finding of findings) {
    const route = finding.target.route;
    if (route === undefined) {
      ungrouped.push(finding);
      continue;
    }
    const section = route.split("/").filter(Boolean)[0] ?? "/";
    const bucket = bySection.get(section) ?? [];
    bucket.push(finding);
    bySection.set(section, bucket);
  }

  const clusters: Cluster[] = [];
  for (const bucket of bySection.values()) {
    if (bucket.length < minMembers) {
      clusters.push({ prefix: "", findings: bucket });
      continue;
    }
    const routes = bucket
      .map((finding) => finding.target.route)
      .filter((route): route is string => route !== undefined);
    clusters.push({ prefix: commonRoutePrefix(routes), findings: bucket });
  }
  if (ungrouped.length > 0) {
    clusters.push({ prefix: "", findings: ungrouped });
  }

  return clusters;
}

/** Fold a cluster into one finding that names the shared fix. */
function mergeCluster(
  cluster: readonly Finding[],
  prefix: string,
  grouping: NonNullable<Rule["group"]>,
): Finding {
  const first = cluster[0]!;
  const routes = cluster
    .map((finding) => finding.target.route)
    .filter((route): route is string => route !== undefined)
    .sort();

  // Every affected screen survives as evidence, so grouping loses no detail —
  // it only changes where the finding points.
  const evidence: Evidence[] = [
    ...routes.map(
      (route): Evidence => ({
        type: "graph",
        ref: route,
        note: "affected screen",
      }),
    ),
    ...cluster.flatMap((finding) => finding.evidence).slice(0, 8),
  ];

  const merged: Finding = {
    ruleId: first.ruleId,
    scope: first.scope,
    severity: highestSeverity(cluster),
    confidence: Math.min(...cluster.map((finding) => finding.confidence)),
    classification: first.classification,
    target: { kind: "route", route: prefix },
    evidence,
    message: grouping.message(cluster.length, prefix),
  };

  if (first.principles) merged.principles = first.principles;
  const proposal = grouping.proposal?.(cluster.length, prefix);
  if (proposal) merged.proposal = proposal;

  // Deduplicated, because a cluster is by definition the same rule firing on
  // several screens and most rules phrase their criteria without naming one.
  // Collecting them verbatim produced a checklist with the same line on it
  // five times, which reads as a broken export rather than as five screens.
  const acceptance = [
    ...new Set(cluster.flatMap((finding) => finding.acceptance ?? [])),
  ].slice(0, 5);
  if (acceptance.length > 0) merged.acceptance = acceptance;

  return merged;
}

function highestSeverity(cluster: readonly Finding[]): Finding["severity"] {
  const order: Finding["severity"][] = [
    "info",
    "low",
    "medium",
    "high",
    "critical",
  ];
  let best = 0;
  for (const finding of cluster) {
    best = Math.max(best, order.indexOf(finding.severity));
  }
  return order[best]!;
}

/** Convenience for rules: an evidence entry pointing at a graph node. */
export function graphEvidence(id: NodeId, note?: string): Evidence {
  return note ? { type: "graph", ref: id, note } : { type: "graph", ref: id };
}
