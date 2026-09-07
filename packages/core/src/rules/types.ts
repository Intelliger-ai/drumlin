import type {
  Finding,
  NodeId,
  PermissionsDocument,
  RuleClassification,
  Severity,
} from "@drumlin/model";
import type { GraphView } from "../graph/view.js";

/** Everything a rule may read. Anything absent here must not be consulted. */
export interface RuleContext {
  view: GraphView;
  /** Screens a user can arrive at directly. */
  entryPoints: NodeId[];
  /**
   * The confirmed role model, when one exists.
   *
   * Rules about access control must stay silent until a human has confirmed
   * this, because an inferred permission model produces confident nonsense
   * about who can see what.
   */
  permissions?: PermissionsDocument;
}

/**
 * How to collapse findings from one rule that share a root cause.
 *
 * Without this, a missing error boundary under a twenty-screen section reports
 * twenty times for what is a single file to add. A reviewer reads that as noise
 * and stops reading, which costs more than the twenty findings are worth.
 */
export interface RuleGrouping {
  /** Below this many members, findings are reported individually. */
  minMembers: number;
  message(count: number, prefix: string): string;
  proposal?(count: number, prefix: string): string;
}

export interface Rule {
  id: string;
  /** IR scope the rule examines, e.g. `screen` or `flow_edge`. */
  scope: string;
  classification: RuleClassification;
  /** Baseline severity before any context adjustment. */
  severity: Severity;
  /** Supporting UX principles. Rationale, never the headline. */
  principles?: string[];
  /** One line explaining what the rule looks for, shown by `drumlin rules`. */
  summary: string;
  group?: RuleGrouping;
  evaluate(context: RuleContext): Finding[];
}
