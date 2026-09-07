import type { Evidence, Finding, GraphNode } from "@drumlin/model";
import { withoutLocaleSegments } from "../graph/reachability.js";
import { graphEvidence } from "./engine.js";
import type { Rule, RuleContext } from "./types.js";

/**
 * State completeness.
 *
 * Every candidate app measured had zero `loading.tsx` and zero `error.tsx`, so
 * "no boundary file" on its own would report every route in the product. These
 * rules fire only where the screen actually reads data *and* handles nothing
 * in-component, which cut the finding count on the first real app from 25 to 10
 * and made every one of them worth reading.
 */

/**
 * Whether a screen reads data at request time.
 *
 * The prerendered check is the load-bearing half. A statically generated route
 * reads data during the build, so there is no request to be slow and no fetch
 * to fail — a loading or error state has nothing to appear for. Without this,
 * every MDX-backed route on a content site is reported twice.
 */
function fetchesData(screen: GraphNode): boolean {
  return screen.context?.async === true && !isPrerendered(screen);
}

function isPrerendered(screen: GraphNode): boolean {
  return screen.properties?.["prerendered"] === true;
}

/**
 * Reads data at all, whenever that happens.
 *
 * Used by the not-found rule, where prerendering makes no difference: a slug
 * that was not in `generateStaticParams` is still requested at runtime, and
 * still has to say the record does not exist.
 */
function readsData(screen: GraphNode): boolean {
  return screen.context?.async === true;
}

function handles(screen: GraphNode, kind: string): boolean {
  const handled = screen.properties?.["handledStates"];
  if (typeof handled !== "object" || handled === null || Array.isArray(handled)) {
    return false;
  }
  return (handled as Record<string, unknown>)[kind] === true;
}

/**
 * The one weak data signal, named so the rules can hedge on it.
 *
 * The indexer emits this only when a screen awaits *something* during render
 * and nothing more specific was found — no `useQuery`, no `prisma.x()`, no
 * `getServerSideProps`. That covers a real data read, and it also covers an
 * `await auth()` guard that redirects and then renders static copy.
 *
 * Found by dogfooding: the root route of a real app was reported as "fetches
 * data ... the user cannot tell broken from empty" on the strength of an auth
 * check. The gap it named was real — the app had no error boundary anywhere —
 * but the sentence described a list screen, and a high-severity finding that
 * misdescribes its own cause is how an agent gets sent to fix the wrong thing.
 */
const WEAK_DATA_EVIDENCE = "awaits a value during render";

function dataNotes(screen: GraphNode): string[] {
  const raw = screen.properties?.["dataEvidence"];
  return Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];
}

/** True when nothing stronger than a bare `await` was observed. */
function onlyWeakEvidence(screen: GraphNode): boolean {
  const notes = dataNotes(screen);
  return notes.length > 0 && notes.every((note) => note === WEAK_DATA_EVIDENCE);
}

function dataEvidence(screen: GraphNode): Evidence[] {
  const raw = screen.properties?.["dataEvidence"];
  const notes = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string")
    : [];

  const evidence: Evidence[] = [graphEvidence(screen.id)];
  const location = screen.sources?.[0];
  if (location) evidence.push({ type: "source", location });
  for (const note of notes.slice(0, 3)) {
    evidence.push({ type: "source", note });
  }
  return evidence;
}

function screenTarget(screen: GraphNode): Finding["target"] {
  const target: Finding["target"] = { kind: "node", node: screen.id };
  if (screen.route !== undefined) target.route = screen.route;
  return target;
}

export const noLoadingState: Rule = {
  id: "state.route.no-loading",
  scope: "screen",
  classification: "deterministic",
  severity: "medium",
  principles: ["doherty-threshold", "aesthetic-usability-effect"],
  summary:
    "A screen that fetches data has no loading state, so it renders nothing while waiting.",
  group: {
    minMembers: 3,
    message: (count, prefix) =>
      `${count} screens under ${prefix} fetch data with no loading state, so each renders nothing while waiting.`,
    proposal: (_count, prefix) =>
      `Add a loading boundary at ${prefix} to cover the whole section, or a per-screen skeleton where the shape differs.`,
  },
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const screen of view.screens) {
      if (!fetchesData(screen)) continue;
      if (view.hasState(screen.id, "loading")) continue;
      if (handles(screen, "loading")) continue;

      // Same hedge as the error rule: see `onlyWeakEvidence`.
      const weak = onlyWeakEvidence(screen);
      const label = view.labelOf(screen.id);

      findings.push({
        ruleId: noLoadingState.id,
        scope: "screen",
        severity: "medium",
        confidence: weak ? 0.6 : 0.85,
        classification: "deterministic",
        principles: noLoadingState.principles!,
        target: screenTarget(screen),
        evidence: dataEvidence(screen),
        message: weak
          ? `${label} awaits a value while rendering and has no loading state, so it renders nothing until that call returns.`
          : `${label} fetches data but has no loading state, so it renders nothing while waiting.`,
        proposal:
          "Add a loading boundary for this segment, or render a skeleton while the request is in flight.",
        acceptance: [
          "Navigating to this screen on a slow connection shows a loading affordance within 100ms.",
        ],
      });
    }

    return findings;
  },
};

export const noErrorState: Rule = {
  id: "state.route.no-error",
  scope: "screen",
  classification: "deterministic",
  severity: "high",
  principles: ["peak-end-rule", "teslers-law"],
  summary:
    "A screen that fetches data has no error state, so a failed request fails silently.",
  group: {
    minMembers: 3,
    message: (count, prefix) =>
      `${count} screens under ${prefix} fetch data with no error state, so a failed request fails silently on each.`,
    proposal: (_count, prefix) =>
      `Add an error boundary at ${prefix} with a retry affordance; it covers every screen in the section.`,
  },
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const screen of view.screens) {
      if (!fetchesData(screen)) continue;
      if (view.hasState(screen.id, "error")) continue;
      if (handles(screen, "error")) continue;

      // Hedged when the only signal is a bare `await`. The problem is the same
      // — an unhandled rejection renders nothing — but saying "fetches data"
      // of an auth guard is a claim the code does not support.
      const weak = onlyWeakEvidence(screen);
      const label = view.labelOf(screen.id);

      findings.push({
        ruleId: noErrorState.id,
        scope: "screen",
        // A silent failure is worse than a slow success: the user cannot tell
        // the difference between broken and empty.
        severity: "high",
        confidence: weak ? 0.6 : 0.85,
        classification: "deterministic",
        principles: noErrorState.principles!,
        target: screenTarget(screen),
        evidence: dataEvidence(screen),
        message: weak
          ? `${label} awaits a value while rendering and has no error state, so if that call fails the screen renders nothing.`
          : `${label} fetches data but has no error state, so a failed request shows nothing and the user cannot tell broken from empty.`,
        proposal:
          "Add an error boundary for this segment, with a message that says what failed and a way to retry.",
        acceptance: [
          "With the request forced to fail, the screen explains the failure and offers a retry.",
        ],
      });
    }

    return findings;
  },
};

/**
 * Dynamic segments mean the record may not exist.
 *
 * Locale segments are removed first: `/[locale]/terms` names no record, and
 * treating its language prefix as a parameter reported every page on an i18n
 * site for a record that cannot be missing.
 */
const DYNAMIC_SEGMENT = /\[[^\]]+\]/;

export const noNotFoundState: Rule = {
  id: "state.route.no-not-found",
  scope: "screen",
  classification: "deterministic",
  severity: "medium",
  principles: ["teslers-law"],
  summary:
    "A screen addressed by a dynamic parameter has no not-found handling for a record that does not exist.",
  group: {
    minMembers: 3,
    message: (count, prefix) =>
      `${count} parameterised screens under ${prefix} handle no not-found case, so a stale URL renders an empty screen on each.`,
    proposal: (_count, prefix) =>
      `Add a not-found boundary at ${prefix}, and call notFound() where the record is loaded.`,
  },
  evaluate({ view }: RuleContext): Finding[] {
    const findings: Finding[] = [];

    for (const screen of view.screens) {
      const route = screen.route;
      if (route === undefined) continue;
      if (!DYNAMIC_SEGMENT.test(withoutLocaleSegments(route))) continue;
      if (!readsData(screen)) continue;
      if (view.hasState(screen.id, "not-found")) continue;

      // An error or empty state will usually catch a missing record, even if it
      // words it badly. Only a screen with none of the three is really silent.
      if (handles(screen, "error") || handles(screen, "empty")) continue;

      findings.push({
        ruleId: noNotFoundState.id,
        scope: "screen",
        severity: "medium",
        confidence: 0.7,
        classification: "deterministic",
        principles: noNotFoundState.principles!,
        target: screenTarget(screen),
        evidence: dataEvidence(screen),
        message: `${route} is addressed by a parameter but handles no not-found case, so a stale or edited URL renders an empty screen.`,
        proposal:
          "Handle the missing record explicitly: a not-found boundary, or an empty state that offers a way back to the list.",
        acceptance: [
          "Requesting this route with an ID that does not exist shows a not-found message and a way onward.",
        ],
      });
    }

    return findings;
  },
};
