import { z } from "zod";
import { NodeIdSchema } from "./ids.js";
import { SourceLocationSchema } from "./provenance.js";

/**
 * The rule output contract. Every finding must be able to say what is wrong in
 * the product, where, and on what evidence — the violated principle is only
 * supporting rationale.
 *
 * See vault/Rules/Rule Output Contract.md and Context/05 UX Rules Engine.md
 */

export const SEVERITIES = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

/** Ascending. Used for sorting and for thresholds. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.indexOf(severity);
}

/**
 * How the finding was established. This is what lets a report separate a
 * measured fact from a heuristic judgement, which matters for trust.
 */
export const RULE_CLASSIFICATIONS = [
  "deterministic",
  "graph",
  "semantic",
  "contextual",
  "runtime",
] as const;
export const RuleClassificationSchema = z.enum(RULE_CLASSIFICATIONS);
export type RuleClassification = z.infer<typeof RuleClassificationSchema>;

export const EVIDENCE_TYPES = [
  "source",
  "graph",
  "runtime",
  "context",
] as const;
export const EvidenceTypeSchema = z.enum(EVIDENCE_TYPES);
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;

export const EvidenceSchema = z.object({
  type: EvidenceTypeSchema,
  /** A graph node ID, a trace ID, or a context key. */
  ref: z.string().optional(),
  location: SourceLocationSchema.optional(),
  note: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const TARGET_KINDS = [
  "node",
  "edge",
  "route",
  "file",
  "project",
] as const;
export const TargetKindSchema = z.enum(TARGET_KINDS);
export type TargetKind = z.infer<typeof TargetKindSchema>;

export const FindingTargetSchema = z.object({
  kind: TargetKindSchema,
  node: NodeIdSchema.optional(),
  from: NodeIdSchema.optional(),
  to: NodeIdSchema.optional(),
  via: NodeIdSchema.optional(),
  route: z.string().optional(),
  file: z.string().optional(),
});
export type FindingTarget = z.infer<typeof FindingTargetSchema>;

export const FindingSchema = z.object({
  ruleId: z.string().min(1),
  /** The IR scope the rule ran against, e.g. `screen`, `flow_edge`. */
  scope: z.string().min(1),
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  classification: RuleClassificationSchema,
  /** Supporting UX principles. Rationale only — never the headline. */
  principles: z.array(z.string()).optional(),
  target: FindingTargetSchema,
  evidence: z.array(EvidenceSchema),
  /** States the product problem, not the rule name. */
  message: z.string().min(1),
  /** What the graph should look like instead, in prose. */
  proposal: z.string().optional(),
  /** Executable or checkable criteria that would prove this resolved. */
  acceptance: z.array(z.string()).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * Stable, human-readable identity for what a finding is about.
 *
 * Deliberately a readable string rather than a hash: it appears in issue files
 * and in diffs, and a reviewer should be able to tell what changed. Kept free
 * of file paths where possible so identity survives a rename.
 */
export function targetKey(target: FindingTarget): string {
  switch (target.kind) {
    case "node":
      return `node:${target.node ?? "?"}`;
    case "edge":
      return `edge:${target.from ?? "?"}->${target.to ?? "?"}${
        target.via ? `@${target.via}` : ""
      }`;
    case "route":
      return `route:${target.route ?? "?"}`;
    case "file":
      return `file:${target.file ?? "?"}`;
    case "project":
      return "project";
  }
}

/**
 * Identity of the underlying problem, stable across runs.
 *
 * This is what maps a re-detected finding back onto an existing issue so its
 * `UX-` number, history, and accepted status survive.
 */
export function findingFingerprint(finding: Finding): string {
  return `${finding.ruleId}|${targetKey(finding.target)}`;
}
