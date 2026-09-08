import { z } from "zod";
import { StateKindSchema } from "./graph.js";

/**
 * What a browser actually did.
 *
 * The counterpart to the inferred graph, and deliberately a different shape
 * rather than a `GraphDocument`. The inferred graph is a claim about what the
 * product can do, derived from source. This is a record of what happened on
 * one run, and conflating the two would lose the distinction the whole
 * comparison rests on: a route missing from the inferred graph is a gap in
 * analysis, while a route missing from an observation may just be a page
 * nobody visited.
 *
 * So an observation is explicit about its own coverage. Everything it does not
 * mention is unknown, never absent.
 *
 * See vault/Runtime/Runtime Verification.md.
 */

/** How a navigation was triggered. */
export const NAVIGATION_KINDS = [
  "visit",
  "click",
  "submit",
  "redirect",
] as const;
export const NavigationKindSchema = z.enum(NAVIGATION_KINDS);
export type NavigationKind = z.infer<typeof NavigationKindSchema>;

/**
 * A control the browser found on a page.
 *
 * Identified by accessible name rather than by selector. A selector says where
 * something is in one build's markup; the accessible name is what a user is
 * looking for, and it is also what survives a refactor — which makes it the
 * only identifier worth comparing across runs.
 */
export const ObservedControlSchema = z.object({
  role: z.string().min(1),
  name: z.string(),
  /** Present when it navigates somewhere resolvable without clicking it. */
  href: z.string().optional(),
  disabled: z.boolean().optional(),
});
export type ObservedControl = z.infer<typeof ObservedControlSchema>;

/**
 * One page, as it was found.
 *
 * `requested` and `settled` are separate because the gap between them is a
 * finding. Asking for `/invoices` and arriving at `/login` is the single most
 * common runtime surprise, and a record that only kept the final URL could not
 * see it.
 */
export const ObservedVisitSchema = z.object({
  /** The route pattern this was meant to exercise, e.g. `/invoices/[id]`. */
  route: z.string().min(1),
  requested: z.string().min(1),
  settled: z.string().min(1),
  status: z.number().int().optional(),
  /** How the browser got here. */
  via: NavigationKindSchema,
  title: z.string().optional(),
  /**
   * States seen while this page settled.
   *
   * Ordered, and the order carries information: `["loading", "empty"]` is a
   * screen that fetched and found nothing, while `["empty"]` alone suggests it
   * rendered empty before it had asked.
   */
  states: z.array(StateKindSchema),
  controls: z.array(ObservedControlSchema),
  /** Console errors and failed requests, which explain most blank screens. */
  errors: z.array(z.string()),
  /** A screenshot path or trace id. Never the bytes. */
  artifact: z.string().optional(),
});
export type ObservedVisit = z.infer<typeof ObservedVisitSchema>;

/** A navigation that happened, and what caused it. */
export const ObservedTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: NavigationKindSchema,
  /** The accessible name of the control that caused it, when there was one. */
  via: z.string().optional(),
});
export type ObservedTransition = z.infer<typeof ObservedTransitionSchema>;

/**
 * One run of the harness.
 *
 * `attempted` is the coverage record and is not optional. Without it there is
 * no way to distinguish "this route works and we checked" from "we never
 * looked", and a diff that cannot tell those apart will report every route it
 * skipped as broken.
 */
export const ObservedGraphSchema = z.object({
  at: z.string(),
  baseUrl: z.string().min(1),
  /** Route patterns the harness set out to exercise. */
  attempted: z.array(z.string()),
  visits: z.array(ObservedVisitSchema),
  transitions: z.array(ObservedTransitionSchema),
  /** Why the run stopped early, if it did. */
  incomplete: z.string().optional(),
});
export type ObservedGraph = z.infer<typeof ObservedGraphSchema>;

export function parseObservedGraph(value: unknown): ObservedGraph {
  return ObservedGraphSchema.parse(value);
}
