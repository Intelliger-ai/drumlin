import { isNonUrlSegment } from "./discover.js";

/**
 * Route pattern handling.
 *
 * The extractor sees hrefs as they appear in source — often a template literal
 * with an interpolation. Matching those back onto the route patterns found on
 * disk is what turns a string into a graph edge.
 */

/** Placeholder used where a template literal interpolated a runtime value. */
export const DYNAMIC = "\u0000dynamic";

export interface RoutePattern {
  /** URL path with Next.js dynamic syntax intact, e.g. `/invoices/[id]`. */
  route: string;
  segments: string[];
}

export function toRoutePattern(route: string): RoutePattern {
  return { route, segments: splitRoute(route) };
}

export function splitRoute(route: string): string[] {
  return route
    .split("?")[0]!
    .split("#")[0]!
    .split("/")
    .filter((segment) => segment.length > 0);
}

/** Build a URL path from App Router directory segments. */
export function routeFromSegments(segments: string[]): string {
  const urlSegments = segments.filter((segment) => !isNonUrlSegment(segment));
  return urlSegments.length === 0 ? "/" : `/${urlSegments.join("/")}`;
}

function isDynamic(segment: string): boolean {
  return segment.startsWith("[") && segment.endsWith("]");
}

function isCatchAll(segment: string): boolean {
  return segment.startsWith("[...") || segment.startsWith("[[...");
}

/**
 * Score how well a concrete href matches a route pattern. Higher is better;
 * `undefined` means no match.
 *
 * Literal segments score above dynamic ones so `/invoices/new` prefers a real
 * `/invoices/new` route over `/invoices/[id]`.
 */
function scoreMatch(
  hrefSegments: string[],
  pattern: RoutePattern,
): number | undefined {
  const patternSegments = pattern.segments;
  let score = 0;

  for (let i = 0; i < patternSegments.length; i += 1) {
    const patternSegment = patternSegments[i]!;
    const hrefSegment = hrefSegments[i];

    if (isCatchAll(patternSegment)) {
      // Optional catch-all also matches zero remaining segments.
      const optional = patternSegment.startsWith("[[");
      if (hrefSegment === undefined && !optional) return undefined;
      return score + 1;
    }

    if (hrefSegment === undefined) return undefined;

    if (isDynamic(patternSegment)) {
      // An interpolated href segment is positive evidence for a dynamic route:
      // `/invoices/${id}` means `/invoices/[id]`, not `/invoices/new`.
      score += hrefSegment === DYNAMIC ? 3 : 1;
      continue;
    }

    if (patternSegment === hrefSegment) {
      score += 10;
      continue;
    }

    // A runtime value can stand in for a literal segment, but it is much weaker
    // evidence than either an exact match or a dynamic route.
    if (hrefSegment === DYNAMIC) {
      score += 1;
      continue;
    }

    return undefined;
  }

  return hrefSegments.length === patternSegments.length ? score : undefined;
}

/** Best-matching known route for an href, or undefined when nothing fits. */
export function matchRoute(
  href: string,
  patterns: readonly RoutePattern[],
): RoutePattern | undefined {
  const segments = splitRoute(href);
  let best: RoutePattern | undefined;
  let bestScore = -1;

  for (const pattern of patterns) {
    const score = scoreMatch(segments, pattern);
    if (score === undefined) continue;
    if (score > bestScore) {
      best = pattern;
      bestScore = score;
    }
  }

  return best;
}

/** True for links that leave the application. */
export function isExternalHref(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("//") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:")
  );
}

/** True for in-page or non-navigational hrefs. */
export function isNonNavigationalHref(href: string): boolean {
  return href.startsWith("#") || href.trim().length === 0;
}

/** The query portion of an href, if any. */
export function hrefQuery(href: string): string | undefined {
  const index = href.indexOf("?");
  return index === -1 ? undefined : href.slice(index + 1);
}
