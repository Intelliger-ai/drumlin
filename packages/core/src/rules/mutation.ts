import type { Finding, GraphNode } from "@drumlin/model";
import { graphEvidence } from "./engine.js";
import type { Rule, RuleContext } from "./types.js";

/**
 * Mutation safety.
 *
 * The detector behind these rules is generous about what counts as feedback or
 * confirmation — a mention of `isPending`, a toast, a dialog. That asymmetry is
 * intentional: a missed finding costs one issue, while a wrong one costs
 * confidence in every other finding in the report.
 */

function isTrue(node: GraphNode, key: string): boolean {
  return node.properties?.[key] === true;
}

/** The screen or component that offers an action, for a useful message. */
function offeredBy(view: RuleContext["view"], action: GraphNode): GraphNode[] {
  return view
    .incoming(action.id)
    .filter((edge) => edge.type === "contains")
    .map((edge) => view.node(edge.from))
    .filter((node): node is GraphNode => node !== undefined);
}

function actionEvidence(
  view: RuleContext["view"],
  action: GraphNode,
): Finding["evidence"] {
  const evidence: Finding["evidence"] = [graphEvidence(action.id)];
  const location = action.sources?.[0];
  if (location) evidence.push({ type: "source", location });
  for (const owner of offeredBy(view, action).slice(0, 3)) {
    evidence.push(graphEvidence(owner.id, "offers this action"));
  }
  return evidence;
}

function actionTarget(
  view: RuleContext["view"],
  action: GraphNode,
): Finding["target"] {
  const target: Finding["target"] = { kind: "node", node: action.id };
  const owner = offeredBy(view, action)[0];
  if (owner?.route !== undefined) target.route = owner.route;
  return target;
}

export const mutationNoFeedback: Rule = {
  id: "async.mutation.no-feedback",
  scope: "action",
  classification: "deterministic",
  severity: "high",
  principles: ["doherty-threshold", "peak-end-rule"],
  summary:
    "A mutation surfaces neither progress nor failure, so the user cannot tell whether it worked.",
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const action of view.nodesOfType("Action")) {
      // Requiring both to be absent keeps this quiet on code that handles one
      // of them. A mutation with neither is genuinely silent.
      if (isTrue(action, "surfacesPending")) continue;
      if (isTrue(action, "surfacesError")) continue;

      const owners = offeredBy(view, action);

      findings.push({
        ruleId: mutationNoFeedback.id,
        scope: "action",
        severity: "high",
        confidence: 0.8,
        classification: "deterministic",
        principles: mutationNoFeedback.principles!,
        target: actionTarget(view, action),
        evidence: actionEvidence(view, action),
        message: `${action.label ?? action.id} changes data${
          owners[0] ? ` from ${view.labelOf(owners[0].id)}` : ""
        } but surfaces neither progress nor failure, so the user cannot tell whether it worked.`,
        proposal:
          "Show pending state while it runs and surface the failure when it fails, with the record left as it was.",
        acceptance: [
          "Triggering the mutation shows progress within 100ms.",
          "Forcing the mutation to fail shows an error that names what failed.",
        ],
      });
    }

    return findings;
  },
};

export const destructiveNoConfirm: Rule = {
  id: "flow.destructive.no-confirm",
  scope: "action",
  classification: "deterministic",
  severity: "critical",
  principles: ["teslers-law", "peak-end-rule"],
  summary:
    "An irreversible action runs with no confirmation and no way to undo it.",
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const action of view.nodesOfType("Action")) {
      if (action.context?.destructive !== true) continue;
      // Either affordance is enough: a prompt beforehand or an undo afterwards.
      if (isTrue(action, "hasConfirmation")) continue;
      if (isTrue(action, "hasUndo")) continue;

      const owners = offeredBy(view, action);

      findings.push({
        ruleId: destructiveNoConfirm.id,
        scope: "action",
        // Data loss the user did not ask for is the worst outcome in the set.
        severity: "critical",
        confidence: 0.85,
        classification: "deterministic",
        principles: destructiveNoConfirm.principles!,
        target: actionTarget(view, action),
        evidence: actionEvidence(view, action),
        message: `${action.label ?? action.id} destroys data${
          owners[0] ? ` from ${view.labelOf(owners[0].id)}` : ""
        } with no confirmation and no undo, so a single misplaced click is unrecoverable.`,
        proposal:
          "Confirm before running it, or make it reversible with an undo window. Confirmation should name what is being destroyed.",
        acceptance: [
          "Triggering the action requires an explicit confirmation that names the affected record, or the action can be undone afterwards.",
        ],
      });
    }

    return findings;
  },
};
