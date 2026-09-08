import type {
  Finding,
  GraphDocument,
  GraphNode,
  ObservedGraph,
  ObservedVisit,
  StateKind,
} from "@drumlin/model";
import { GraphView } from "../graph/view.js";

/**
 * Diffing what the source says against what the browser did.
 *
 * The inferred graph is a claim. Every rule in `packages/core/src/rules` reads
 * it and reasons about the product as described by its own code, which means a
 * whole class of problem is structurally invisible: the code that renders an
 * error state is present and correct, and the error state never appears
 * because the request that would trigger it is swallowed three layers down.
 *
 * This module is the other direction. It takes one run of the harness and asks
 * where the product disagreed with its own source.
 *
 * The asymmetry that governs everything here: **absence in an observation is
 * not evidence.** A route the harness never opened tells us nothing, and a
 * diff that treats "not seen" as "not there" reports the harness's coverage
 * gaps as product defects. So every check below is gated on the route having
 * actually been attempted.
 *
 * See vault/Runtime/Expected Versus Observed.md.
 */

export interface DiffOptions {
  /**
   * Report routes the browser reached that the graph does not describe.
   *
   * Off by default. These are usually a gap in static analysis rather than a
   * product problem, and reporting them as UX findings puts Drumlin's own
   * blind spots on the developer's list.
   */
  reportUndeclared?: boolean;
}

/** Rule ids for runtime findings, namespaced so they read as a family. */
export const RUNTIME_RULES = {
  unreachable: "runtime.screen.unreachable",
  redirected: "runtime.screen.redirected",
  missingState: "runtime.state.never-rendered",
  brokenTransition: "runtime.transition.wrong-destination",
  deadControl: "runtime.control.does-nothing",
  consoleError: "runtime.screen.console-error",
  undeclared: "runtime.screen.undeclared",
} as const;

export function diffObserved(
  expected: GraphDocument,
  observed: ObservedGraph,
  options: DiffOptions = {},
): Finding[] {
  const view = new GraphView(expected);
  const findings: Finding[] = [];

  const attempted = new Set(observed.attempted);
  const byRoute = new Map<string, ObservedVisit[]>();
  for (const visit of observed.visits) {
    byRoute.set(visit.route, [...(byRoute.get(visit.route) ?? []), visit]);
  }

  for (const screen of view.nodesOfType("Screen")) {
    const route = screen.route;
    if (!route) continue;
    // Coverage gate. Everything below this line is only meaningful for a route
    // the harness actually tried.
    if (!attempted.has(route)) continue;

    const visits = byRoute.get(route) ?? [];
    if (visits.length === 0) {
      findings.push(unreachable(screen, route, observed));
      continue;
    }

    for (const visit of visits) {
      const redirect = redirected(screen, visit, observed);
      if (redirect) {
        // A screen that redirects away has not been exercised, so the state and
        // control checks below would all fire on whatever page we landed on.
        findings.push(redirect);
        continue;
      }
      findings.push(...missingStates(view, screen, visit, observed));
      findings.push(...consoleErrors(screen, visit, observed));
    }
  }

  findings.push(...brokenTransitions(view, observed, attempted));

  if (options.reportUndeclared) {
    findings.push(...undeclared(view, observed));
  }

  return findings;
}

function unreachable(
  screen: GraphNode,
  route: string,
  observed: ObservedGraph,
): Finding {
  return {
    ruleId: RUNTIME_RULES.unreachable,
    scope: "screen",
    severity: "critical",
    confidence: 0.9,
    classification: "runtime",
    target: { kind: "node", node: screen.id, route },
    evidence: [
      {
        type: "runtime",
        ref: screen.id,
        note: `the harness opened ${route} and no page settled there`,
      },
      { type: "graph", ref: screen.id, note: "declared as a screen in source" },
    ],
    message:
      `${route} exists in the code but did not render when opened. ` +
      `A route that cannot be reached is not a screen, whatever the source says.`,
    proposal:
      "Open the route and find out what it does instead — the usual causes are " +
      "a failed data fetch with no error boundary, a redirect loop, or a build " +
      "error confined to that page.",
    acceptance: [`Opening ${route} in a browser renders a page.`],
  };
}

function redirected(
  screen: GraphNode,
  visit: ObservedVisit,
  observed: ObservedGraph,
): Finding | undefined {
  if (samePath(visit.requested, visit.settled)) return undefined;

  return {
    ruleId: RUNTIME_RULES.redirected,
    scope: "screen",
    severity: "high",
    confidence: 0.8,
    classification: "runtime",
    target: {
      kind: "node",
      node: screen.id,
      route: screen.route ?? visit.route,
    },
    evidence: [
      {
        type: "runtime",
        ref: screen.id,
        note: `requested ${visit.requested}, settled at ${visit.settled}`,
      },
    ],
    message:
      `${visit.requested} sends the user to ${visit.settled} instead of ` +
      `rendering. The redirect is not visible in the source, so anything ` +
      `linking here is quietly pointing somewhere else.`,
    proposal:
      "If the redirect is intended, say so in the code that owns the route so " +
      "the graph knows — otherwise the screen and every link to it are " +
      "describing a page that does not exist.",
    acceptance: [
      `Opening ${visit.requested} either renders it, or the redirect is declared.`,
    ],
  };
}

/**
 * States the source declares that never appeared.
 *
 * The highest-value check here and the one that most needs its coverage gate.
 * A `loading` state that never rendered might mean the fetch resolved from
 * cache faster than the harness could look, which is not a defect — so only
 * states that the run was in a position to observe are reported.
 */
function missingStates(
  view: GraphView,
  screen: GraphNode,
  visit: ObservedVisit,
  observed: ObservedGraph,
): Finding[] {
  const seen = new Set<StateKind>(visit.states);
  const findings: Finding[] = [];

  for (const state of view.contained(screen.id, "State")) {
    const kind = state.stateKind;
    if (!kind) continue;
    if (seen.has(kind)) continue;
    // Only states the harness can force. It cannot make a server fail on
    // demand without a fixture, and reporting `error` as never-rendered on a
    // run that never induced an error would be reporting our own limitation.
    if (!OBSERVABLE_WITHOUT_FIXTURES.has(kind)) continue;

    findings.push({
      ruleId: RUNTIME_RULES.missingState,
      scope: "state",
      severity: kind === "error" ? "high" : "medium",
      confidence: 0.6,
      classification: "runtime",
      target: { kind: "node", node: state.id, route: screen.route },
      evidence: [
        {
          type: "runtime",
          ref: state.id,
          note: `states observed on ${visit.route}: ${
            visit.states.length > 0 ? visit.states.join(", ") : "none"
          }`,
        },
        {
          type: "graph",
          ref: state.id,
          note: `source declares a ${kind} state for this screen`,
        },
      ],
      message:
        `${screen.route ?? screen.id} has a ${kind} state in the code that did ` +
        `not appear when the screen was exercised. Either the condition never ` +
        `reaches it, or the user sees something else in its place.`,
      proposal: `Reach the ${kind} case in a browser and confirm what renders.`,
      acceptance: [
        `The ${kind} state is observable on ${screen.route ?? screen.id}.`,
      ],
    });
  }

  return findings;
}

/**
 * States a run can provoke by itself.
 *
 * `loading` and `submitting` happen on the way to anything. The rest need a
 * server that fails, an account with no data, or a permission the test user
 * lacks — none of which the harness can arrange, so their absence from a run
 * says nothing.
 */
const OBSERVABLE_WITHOUT_FIXTURES = new Set<StateKind>([
  "loading",
  "submitting",
]);

/**
 * Navigations the source promises that the browser did not honour.
 *
 * Only checked where the run actually clicked something, which is why this
 * reads the observed transitions rather than iterating the expected ones.
 * Iterating expectations would report every link nobody clicked.
 */
function brokenTransitions(
  view: GraphView,
  observed: ObservedGraph,
  attempted: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];

  for (const transition of observed.transitions) {
    if (transition.kind === "redirect") continue;
    if (!attempted.has(transition.from)) continue;

    const from = view
      .nodesOfType("Screen")
      .find((node) => node.route === transition.from);
    if (!from) continue;

    // What the source says clicking this leads to. Compared as a set because a
    // control can legitimately reach one of several screens.
    const declared = view
      .transitionsOut(from.id)
      .map((edge) => view.node(edge.to)?.route)
      .filter((route): route is string => route !== undefined);

    if (declared.length === 0) continue;
    if (declared.some((route) => samePath(route, transition.to))) continue;

    findings.push({
      ruleId: RUNTIME_RULES.brokenTransition,
      scope: "flow_edge",
      severity: "high",
      confidence: 0.7,
      classification: "runtime",
      target: {
        kind: "edge",
        from: from.id,
        route: transition.from,
      },
      evidence: [
        {
          type: "runtime",
          ref: from.id,
          note:
            `${transition.via ? `"${transition.via}"` : transition.kind} on ` +
            `${transition.from} went to ${transition.to}`,
        },
        {
          type: "graph",
          ref: from.id,
          note: `source suggests it leads to ${declared.join(", ")}`,
        },
      ],
      message:
        `${transition.via ? `"${transition.via}"` : "A navigation"} on ` +
        `${transition.from} goes to ${transition.to}, which is not among the ` +
        `destinations its code describes (${declared.join(", ")}).`,
      proposal:
        "One of the two is wrong. Either the destination changed and nothing " +
        "linking here was updated, or the handler is sending people somewhere " +
        "the code does not admit to.",
      acceptance: [
        `Navigation from ${transition.from} matches what the source describes.`,
      ],
    });
  }

  return findings;
}

function consoleErrors(
  screen: GraphNode,
  visit: ObservedVisit,
  observed: ObservedGraph,
): Finding[] {
  if (visit.errors.length === 0) return [];

  return [
    {
      ruleId: RUNTIME_RULES.consoleError,
      scope: "screen",
      // Medium rather than high: a console error is a symptom, and plenty are
      // harmless third-party noise. It earns a place because it explains the
      // blank screens the other checks report without a cause.
      severity: "medium",
      confidence: 0.5,
      classification: "runtime",
      target: { kind: "node", node: screen.id, route: screen.route },
      evidence: visit.errors.slice(0, 3).map((error) => ({
        type: "runtime" as const,
        ref: screen.id,
        note: error,
      })),
      message:
        `${screen.route ?? screen.id} logged ${visit.errors.length} error(s) ` +
        `while rendering. The page may still look correct and be failing for ` +
        `some of its users.`,
      acceptance: [
        `${screen.route ?? screen.id} renders without console errors.`,
      ],
    },
  ];
}

function undeclared(view: GraphView, observed: ObservedGraph): Finding[] {
  const declared = new Set(
    view
      .nodesOfType("Screen")
      .map((node) => node.route)
      .filter((route): route is string => route !== undefined),
  );

  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const visit of observed.visits) {
    if (declared.has(visit.route)) continue;
    if (seen.has(visit.settled)) continue;
    seen.add(visit.settled);

    findings.push({
      ruleId: RUNTIME_RULES.undeclared,
      scope: "screen",
      severity: "low",
      confidence: 0.5,
      classification: "runtime",
      target: { kind: "route", route: visit.settled },
      evidence: [
        {
          type: "runtime",
          note: `the browser rendered ${visit.settled}, which is not in the graph`,
        },
      ],
      message:
        `${visit.settled} renders in the browser but does not appear in the ` +
        `graph, so no rule has ever looked at it.`,
      proposal:
        "Most often this is Drumlin's blind spot rather than a product " +
        "problem — a route defined in a way the indexer does not recognise.",
    });
  }

  return findings;
}

/** Compare paths ignoring trailing slashes and query strings. */
function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(value: string): string {
  const withoutQuery = value.split("?")[0]?.split("#")[0] ?? value;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
