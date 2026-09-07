import { withoutLocaleSegments, type GraphNode, type NodeId } from "@drumlin/model";
import type { GraphView } from "./view.js";

export { withoutLocaleSegments };

/**
 * Reachability, entry points, orphans, and dead ends.
 *
 * The hard part is not the traversal — it is deciding what counts as a way in.
 * Both orphan and dead-end detection are only as good as that decision, and
 * getting it wrong produces confident findings about screens that are perfectly
 * fine.
 */

/**
 * Routes that are entered directly rather than navigated to.
 *
 * An emailed password-reset link, an invite token, or a signup page is reached
 * from outside the product. Measured against the first real app, treating these
 * as orphans accounted for four of five false positives.
 */
const ENTRY_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/$/,
  /(^|\/)(login|signin|sign-in|logout|signout)(\/|$)/i,
  /(^|\/)(signup|sign-up|register|onboarding)(\/|$)/i,
  /(^|\/)(forgot-password|reset-password|set-password|new-password)(\/|$)/i,
  /(^|\/)(verify|verify-request|verify-email|confirm|activate)(\/|$)/i,
  /(^|\/)(invite|invitation|accept-invite)(\/|$)/i,
  /(^|\/)(auth|oauth|callback|sso|magic-link)(\/|$)/i,
  /(^|\/)(unsubscribe|share|public|embed|preview)(\/|$)/i,
  /(^|\/)(404|500|not-found|error)(\/|$)/i,
  // Development and test harnesses. Reached by typing a URL on purpose, which
  // is the whole point of them — every finding on one app was of this kind.
  /(^|\/)(dev|development|e2e|playground|sandbox|storybook|debug)(\/|$)/i,
  /(^|\/)__[^/]*(\/|$)/,
];

/** Dynamic segments that name a secret, meaning the URL arrives from outside. */
const TOKEN_SEGMENT = /\[(\.\.\.)?[^\]]*(token|code|secret|key|hash|nonce|otp)[^\]]*\]/i;


export interface EntryPointOptions {
  /** Routes the user declared as entry points, which always win. */
  declared?: readonly string[];
}

/** True when a route is conventionally entered from outside the product. */
export function isConventionalEntryRoute(route: string): boolean {
  if (TOKEN_SEGMENT.test(route)) return true;
  const canonical = withoutLocaleSegments(route);
  return ENTRY_ROUTE_PATTERNS.some(
    (pattern) => pattern.test(route) || pattern.test(canonical),
  );
}

/**
 * Screens a user can arrive at without navigating from another screen.
 *
 * Declared entry points are authoritative. Everything else is convention, and
 * convention is why this stays a heuristic rather than a fact.
 */
export function entryPoints(
  view: GraphView,
  options: EntryPointOptions = {},
): NodeId[] {
  const declared = new Set(options.declared ?? []);
  const found: NodeId[] = [];

  for (const screen of view.screens) {
    const route = screen.route;
    if (route === undefined) continue;
    if (declared.has(route) || isConventionalEntryRoute(route)) {
      found.push(screen.id);
    }
  }

  return found.sort();
}

/**
 * Every node reachable from a set of starting nodes.
 *
 * Chrome transitions are included: a link in the sidebar is a real way to get
 * somewhere, even though it is not a way onward from any particular screen.
 */
export function reachableFrom(
  view: GraphView,
  starts: readonly NodeId[],
): Set<NodeId> {
  const seen = new Set<NodeId>();
  const queue = [...starts];

  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of view.transitionsOut(current)) {
      if (!seen.has(edge.to)) queue.push(edge.to);
    }
  }

  return seen;
}

/**
 * Screens that exist but cannot be reached from any entry point.
 *
 * A screen whose route is named anywhere else in the app is excluded even
 * without a resolvable edge. Not every link can be turned into one: an href
 * assembled by a helper, or written in a markdown article, is a real link that
 * static analysis cannot follow. Reporting those made 18 of 44 orphan findings
 * on a real app wrong, and the cost of the exclusion is only that a page linked
 * solely from another orphan stops being reported.
 */
export function orphanScreens(
  view: GraphView,
  options: EntryPointOptions = {},
): GraphNode[] {
  const starts = entryPoints(view, options);
  const reachable = reachableFrom(view, starts);

  return view.screens
    .filter((screen) => !reachable.has(screen.id))
    .filter((screen) => !isMentionedElsewhere(screen))
    .sort((a, b) => (a.route ?? a.id).localeCompare(b.route ?? b.id));
}

/** Whether the route is named in a file other than its own. */
export function isMentionedElsewhere(screen: GraphNode): boolean {
  const mentions = screen.properties?.["mentionedIn"];
  return Array.isArray(mentions) && mentions.length > 0;
}

export interface DeadEnd {
  screen: GraphNode;
  /** In-content transitions that led here, as evidence it is inside a flow. */
  inboundCount: number;
  /** Actions the screen offers, as evidence something happens here. */
  actions: GraphNode[];
}

/**
 * Screens a user can get stuck on.
 *
 * Three conditions, all needed. The screen must be reachable by an in-content
 * link, so it is part of a flow rather than a bookmarked page. It must offer no
 * in-content way onward. And something must happen there — an action to perform
 * — because a screen where the user does something and is then offered no next
 * step is a real problem, while a static leaf page is not.
 *
 * Requiring only "no way onward" reported a quarter of the first real app; with
 * chrome navigation counted it reported nothing. Both were useless.
 */
export function deadEnds(view: GraphView): DeadEnd[] {
  const found: DeadEnd[] = [];

  for (const screen of view.screens) {
    const inbound = view.transitionsIn(screen.id, { chrome: false });
    if (inbound.length === 0) continue;

    const onward = view.transitionsOut(screen.id, { chrome: false });
    if (onward.length > 0) continue;

    const actions = view.actionsOf(screen.id);
    if (actions.length === 0) continue;

    found.push({ screen, inboundCount: inbound.length, actions });
  }

  return found.sort((a, b) =>
    (a.screen.route ?? a.screen.id).localeCompare(b.screen.route ?? b.screen.id),
  );
}

/**
 * The longest route prefix shared by a set of routes.
 *
 * Used to find where a missing state boundary should actually be added: if
 * twenty screens under `/portal` all lack an error boundary, the fix is one
 * file at `/portal`, not twenty findings.
 */
export function commonRoutePrefix(routes: readonly string[]): string {
  if (routes.length === 0) return "/";

  const split = routes.map((route) =>
    route.split("/").filter((segment) => segment.length > 0),
  );
  const shortest = Math.min(...split.map((segments) => segments.length));
  const prefix: string[] = [];

  for (let index = 0; index < shortest; index += 1) {
    const segment = split[0]![index]!;
    if (!split.every((segments) => segments[index] === segment)) break;
    prefix.push(segment);
  }

  return prefix.length === 0 ? "/" : `/${prefix.join("/")}`;
}
