import {
  findingFingerprint,
  isOpen,
  type Finding,
  type Issue,
  type IssueCounts,
  type IssueEvent,
} from "@drumlin/model";

/**
 * Turning findings into issues.
 *
 * The whole job is continuity. A finding has no identity — it is recomputed
 * from scratch on every run — so this is what makes `UX-0184` mean the same
 * problem tomorrow, keeps a human's decision to accept it, and avoids
 * renumbering everything when a rule's output shifts.
 */

export interface ReconcileInput {
  findings: readonly Finding[];
  existing: readonly Issue[];
  /** ISO timestamp for this run. Injected so results stay deterministic. */
  now: string;
  /**
   * Allocate or look up the `UX-` number for a problem fingerprint.
   *
   * Numbering lives with persistence, not here, because it needs to be durable
   * across processes. Injecting it keeps this function pure.
   */
  allocateId(fingerprint: string): string;
}

export interface ReconcileResult {
  issues: Issue[];
  counts: IssueCounts;
  /** Issues on record that no rule reported this run. */
  undetected: Issue[];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const byFingerprint = new Map(
    input.existing.map((issue) => [issue.fingerprint, issue]),
  );
  const seen = new Set<string>();

  const issues: Issue[] = [];
  let introduced = 0;
  let stillOpen = 0;
  let accepted = 0;

  for (const finding of input.findings) {
    const fingerprint = findingFingerprint(finding);
    seen.add(fingerprint);

    const existing = byFingerprint.get(fingerprint);

    if (!existing) {
      issues.push(newIssue(finding, fingerprint, input));
      introduced += 1;
      stillOpen += 1;
      continue;
    }

    const updated = refresh(existing, finding, input.now);
    issues.push(updated);

    if (updated.status === "accepted") accepted += 1;
    else if (isOpen(updated.status)) stillOpen += 1;
  }

  // Issues nobody reported this run stay on record, untouched. Dropping them
  // would lose the `UX-` number and any acceptance decision attached to it.
  const undetected = input.existing.filter(
    (issue) => !seen.has(issue.fingerprint),
  );
  issues.push(...undetected);

  return {
    issues: issues.sort((a, b) => a.id.localeCompare(b.id)),
    counts: {
      total: issues.length,
      introduced,
      stillOpen,
      accepted,
      noLongerDetected: undetected.length,
    },
    undetected,
  };
}

function newIssue(
  finding: Finding,
  fingerprint: string,
  input: ReconcileInput,
): Issue {
  const issue: Issue = {
    id: input.allocateId(fingerprint),
    fingerprint,
    status: "detected",
    severity: finding.severity,
    confidence: finding.confidence,
    classification: finding.classification,
    rule: { id: finding.ruleId },
    target: finding.target,
    evidence: finding.evidence,
    message: finding.message,
    detectedAt: input.now,
    updatedAt: input.now,
    history: [
      { at: input.now, to: "detected", by: "rule-engine" },
    ],
  };
  if (finding.principles) issue.principles = finding.principles;
  if (finding.proposal) issue.proposal = finding.proposal;
  if (finding.acceptance) issue.acceptance = finding.acceptance;
  return issue;
}

/**
 * Update an existing issue from a fresh finding.
 *
 * Evidence and severity are refreshed because the code moved; status is not,
 * because status reflects human and verifier decisions that a re-run has no
 * standing to overturn. An accepted issue in particular stays accepted.
 */
function refresh(existing: Issue, finding: Finding, now: string): Issue {
  const updated: Issue = {
    ...existing,
    severity: finding.severity,
    confidence: finding.confidence,
    classification: finding.classification,
    target: finding.target,
    evidence: finding.evidence,
    message: finding.message,
    updatedAt: now,
  };

  if (finding.principles) updated.principles = finding.principles;
  if (finding.proposal) updated.proposal = finding.proposal;
  if (finding.acceptance) updated.acceptance = finding.acceptance;

  // A finding reappearing on an issue that had been resolved is a regression,
  // and reopening is the one status change re-detection does justify.
  if (existing.status === "resolved") {
    const event: IssueEvent = {
      at: now,
      from: "resolved",
      to: "reopened",
      by: "rule-engine",
      note: "re-detected by the rule that originally found it",
    };
    updated.status = "reopened";
    updated.history = [...(existing.history ?? []), event];
  }

  return updated;
}
