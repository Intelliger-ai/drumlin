import type { Finding, GraphNode } from "@drumlin/model";
import { graphEvidence } from "./engine.js";
import type { Rule, RuleContext } from "./types.js";

/**
 * Context preservation across navigation.
 *
 * Framed deliberately narrowly. The interesting failure is not "a link has no
 * query string" — most should not. It is a user who filtered a list, opened one
 * row, came back, and found their filters gone. That requires the destination
 * to be a filtered list and the source to be somewhere you arrive at from it.
 */

function searchParamKeys(screen: GraphNode): string[] {
  const raw = screen.properties?.["searchParamKeys"];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

/** Params that identify a record rather than a view, so losing them is fine. */
const IDENTITY_PARAMS = new Set([
  "id",
  "token",
  "code",
  "callbackurl",
  "redirect",
  "redirecturl",
  "next",
  "returnto",
  "email",
]);

function viewParams(screen: GraphNode): string[] {
  return searchParamKeys(screen).filter(
    (key) => !IDENTITY_PARAMS.has(key.toLowerCase()),
  );
}

export const dropsSearchParams: Rule = {
  id: "context.navigation.drops-search-params",
  scope: "flow_edge",
  classification: "graph",
  severity: "medium",
  principles: ["teslers-law", "goal-gradient-effect"],
  summary:
    "Returning to a filtered list discards the filters the user had applied.",
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const screen of view.screens) {
      for (const edge of view.transitionsOut(screen.id, { chrome: false })) {
        const destination = view.node(edge.to);
        if (destination?.type !== "Screen") continue;

        // The destination has to be a view whose state lives in the URL.
        const keys = viewParams(destination);
        if (keys.length === 0) continue;

        // The link has to carry nothing forward.
        const preserved = edge.preserve ?? [];
        if (preserved.length > 0) continue;
        if (edge.properties?.["forwardsSearchParams"] === true) continue;

        // And the user has to be coming back rather than arriving fresh:
        // either the destination links here, or this screen sits beneath it.
        const returnsFrom = view
          .transitionsOut(destination.id, { chrome: false })
          .some((candidate) => candidate.to === screen.id);
        const nestedUnder =
          destination.route !== undefined &&
          screen.route !== undefined &&
          screen.route.startsWith(`${destination.route}/`);
        if (!returnsFrom && !nestedUnder) continue;

        const evidence = [
          graphEvidence(destination.id, `reads ${keys.join(", ")}`),
          graphEvidence(screen.id),
        ];
        const location = edge.sources?.[0];
        if (location) evidence.push({ type: "source", location });

        findings.push({
          ruleId: dropsSearchParams.id,
          scope: "flow_edge",
          severity: "medium",
          confidence: 0.8,
          classification: "graph",
          principles: dropsSearchParams.principles!,
          target: {
            kind: "edge",
            from: screen.id,
            to: destination.id,
            ...(screen.route !== undefined ? { route: screen.route } : {}),
          },
          evidence,
          message: `Going from ${view.labelOf(screen.id)} back to ${view.labelOf(
            destination.id,
          )} drops ${keys.join(", ")}, so the user loses the filters they had applied.`,
          proposal: `Carry the existing search params through this navigation, so returning restores ${keys.join(
            ", ",
          )}.`,
          acceptance: [
            `Filtering ${view.labelOf(destination.id)}, navigating onward, then returning leaves the filters applied.`,
          ],
        });
      }
    }

    return findings;
  },
};
