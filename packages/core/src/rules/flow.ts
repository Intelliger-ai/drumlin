import type { Finding } from "@drumlin/model";
import { deadEnds, orphanScreens } from "../graph/reachability.js";
import { graphEvidence } from "./engine.js";
import type { Rule, RuleContext } from "./types.js";

/**
 * Graph structure.
 *
 * These are the rules that most need the graph to be right, which is why the
 * graph got validated against a real app before either of them was written.
 */

export const deadEnd: Rule = {
  id: "flow.dead-end",
  scope: "screen",
  classification: "graph",
  severity: "medium",
  principles: ["goal-gradient-effect", "peak-end-rule"],
  summary:
    "A screen inside a flow lets the user act but offers no way onward.",
  evaluate({ view }: RuleContext): Finding[] {
    return deadEnds(view).map(({ screen, inboundCount, actions }) => {
      const evidence = [
        graphEvidence(screen.id),
        ...actions
          .slice(0, 3)
          .map((action) => graphEvidence(action.id, "action offered here")),
      ];
      const location = screen.sources?.[0];
      if (location) evidence.push({ type: "source", location });

      const target: Finding["target"] = { kind: "node", node: screen.id };
      if (screen.route !== undefined) target.route = screen.route;

      return {
        ruleId: deadEnd.id,
        scope: "screen",
        severity: "medium",
        // Reachable by an in-content link, offers an action, offers no way
        // onward. Strong evidence, but "onward" is still inferred from links.
        confidence: 0.7,
        classification: "graph" as const,
        principles: deadEnd.principles!,
        target,
        evidence,
        message: `${view.labelOf(screen.id)} is reached from ${inboundCount} place${
          inboundCount === 1 ? "" : "s"
        } and offers ${actions.length} action${
          actions.length === 1 ? "" : "s"
        }, but nothing on the screen leads anywhere afterwards.`,
        proposal:
          "After the action completes, offer the next step explicitly — return to the list, move to the next item, or confirm and continue.",
        acceptance: [
          "Completing the action on this screen presents a next step without using browser back or global navigation.",
        ],
      };
    });
  },
};

export const orphan: Rule = {
  id: "flow.orphan",
  scope: "screen",
  classification: "graph",
  severity: "medium",
  principles: ["jakobs-law"],
  summary:
    "A screen exists but no navigation reaches it from any entry point.",
  // A whole unreachable section is one decision, not nine. On the first real
  // app this was a rebrand leaving three sections of pages behind; reading it
  // as 29 separate findings hid the fact that it was three.
  group: {
    minMembers: 3,
    message: (count, prefix) =>
      `${count} screens under ${prefix} are unreachable, so the whole section can only be entered by typing a URL.`,
    proposal: (_count, prefix) =>
      `Decide about the section as a whole: link ${prefix} from navigation, or delete it if it is left over.`,
  },
  evaluate({ view, entryPoints }: RuleContext): Finding[] {
    const declared = entryPoints
      .map((id) => view.node(id)?.route)
      .filter((route): route is string => route !== undefined);

    return orphanScreens(view, { declared }).map((screen) => {
      const evidence = [graphEvidence(screen.id)];
      const location = screen.sources?.[0];
      if (location) evidence.push({ type: "source", location });

      const target: Finding["target"] = { kind: "node", node: screen.id };
      if (screen.route !== undefined) target.route = screen.route;

      return {
        ruleId: orphan.id,
        scope: "screen",
        severity: "medium",
        confidence: 0.8,
        classification: "graph" as const,
        principles: orphan.principles!,
        target,
        evidence,
        message: `${view.labelOf(screen.id)} exists but nothing links to it, so it can only be reached by typing the URL.`,
        proposal:
          "Link to it from where the user would look for it, or delete it. If it is meant to be entered directly, record it as an entry point in .drumlin/config.yaml.",
        acceptance: [
          "The screen is reachable by clicking from an entry point, or it is declared as an entry point.",
        ],
      };
    });
  },
};
