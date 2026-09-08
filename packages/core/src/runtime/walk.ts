import type {
  GraphDocument,
  GraphNode,
  ObservedGraph,
  ObservedTransition,
  ObservedVisit,
} from "@drumlin/model";
import { GraphView } from "../graph/view.js";
import type { PageProbe, ProbeResult } from "./page.js";

/**
 * Walking the inferred graph in a browser.
 *
 * The graph is the test plan. That is the whole idea: Drumlin already knows
 * every route, which of them are data-driven, and what each one claims to
 * navigate to, so it can drive the app without anybody writing a test — and
 * the routes it visits are exactly the ones whose behaviour it has an
 * expectation for.
 *
 * The output is an `ObservedGraph`, which records what it attempted as well as
 * what it saw. That distinction is load-bearing downstream: `diffObserved`
 * only draws conclusions about routes that appear in `attempted`, so a walk
 * that skips something makes the diff silent rather than wrong.
 *
 * See vault/Runtime/Playwright Harness.md.
 */

export interface WalkOptions {
  /** Prefixed to every route. No trailing slash. */
  baseUrl: string;
  /** Cap on pages opened. A walk that never finishes is a hang, not a check. */
  maxVisits?: number;
  /**
   * Follow controls to see where they lead.
   *
   * Off by default, because clicking things in an application you do not own
   * is how a harness sends an email or deletes a record. See `skipDestructive`.
   */
  followControls?: boolean;
  /**
   * Controls whose names suggest they do something irreversible.
   *
   * Consulted whenever `followControls` is on. The default list is deliberately
   * broad: the cost of skipping a safe button is one unexercised transition,
   * and the cost of pressing an unsafe one is somebody's data.
   */
  skipDestructive?: readonly string[];
  /** Concrete values for dynamic segments, e.g. `{ id: "1" }`. */
  params?: Record<string, string>;
  /** Routes to leave alone entirely. */
  exclude?: readonly string[];
}

/**
 * Names a walk will not click.
 *
 * Matched as substrings, case-insensitively, against the accessible name.
 * Erring toward skipping is the only defensible default for a tool that runs
 * against a developer's own dev server, where the data is often real.
 */
const DESTRUCTIVE_BY_DEFAULT = [
  "delete",
  "remove",
  "archive",
  "cancel",
  "revoke",
  "deactivate",
  "disable",
  "reset",
  "clear",
  "send",
  "publish",
  "approve",
  "reject",
  "pay",
  "purchase",
  "sign out",
  "log out",
  "logout",
];

const DEFAULT_MAX_VISITS = 50;

export async function walkGraph(
  expected: GraphDocument,
  probe: PageProbe,
  options: WalkOptions,
): Promise<ObservedGraph> {
  const view = new GraphView(expected);
  const maxVisits = options.maxVisits ?? DEFAULT_MAX_VISITS;
  const exclude = new Set(options.exclude ?? []);
  const destructive = options.skipDestructive ?? DESTRUCTIVE_BY_DEFAULT;

  const attempted: string[] = [];
  const visits: ObservedVisit[] = [];
  const transitions: ObservedTransition[] = [];
  let incomplete: string | undefined;

  const screens = view
    .nodesOfType("Screen")
    .filter(
      (screen): screen is GraphNode & { route: string } =>
        typeof screen.route === "string",
    )
    // Shallowest first. If the walk is going to be cut short by `maxVisits`,
    // the routes nearest the entry points are the ones worth having.
    .sort(
      (a, b) =>
        depth(a.route) - depth(b.route) || a.route.localeCompare(b.route),
    );

  for (const screen of screens) {
    if (exclude.has(screen.route)) continue;

    if (visits.length >= maxVisits) {
      incomplete =
        `stopped after ${maxVisits} pages; ` +
        `${screens.length - attempted.length} route(s) not visited`;
      break;
    }

    const url = concretize(screen.route, options.params ?? {});
    if (url === undefined) {
      // A dynamic route with no value to put in it. Recording this as
      // unattempted is the honest outcome — visiting `/invoices/[id]`
      // literally would 404 and be reported as a broken screen.
      continue;
    }

    attempted.push(screen.route);

    let result: ProbeResult;
    try {
      result = await probe.open(`${options.baseUrl}${url}`);
    } catch (error) {
      // A probe that throws is a fact about the page, not a reason to abandon
      // the walk. Recorded as a visit with the failure as its error.
      visits.push({
        route: screen.route,
        requested: url,
        settled: url,
        via: "visit",
        states: [],
        controls: [],
        errors: [message(error)],
      });
      continue;
    }

    visits.push({
      route: screen.route,
      requested: url,
      settled: pathOf(result.url, options.baseUrl),
      via: "visit",
      states: result.states,
      controls: result.controls,
      errors: result.errors,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.title !== undefined ? { title: result.title } : {}),
      ...(result.artifact !== undefined ? { artifact: result.artifact } : {}),
    });

    if (!options.followControls) continue;

    for (const control of result.controls) {
      if (control.disabled) continue;
      if (isDestructive(control.name, destructive)) continue;
      // A control with an href has already told us where it goes. Clicking it
      // to learn what we can read is a page load spent for nothing.
      if (control.href) {
        transitions.push({
          from: screen.route,
          to: pathOf(control.href, options.baseUrl),
          kind: "click",
          via: control.name,
        });
        continue;
      }

      try {
        const after = await probe.activate(control.name);
        const landed = pathOf(after.url, options.baseUrl);
        if (!samePath(landed, url)) {
          transitions.push({
            from: screen.route,
            to: landed,
            kind: "click",
            via: control.name,
          });
        }
        // Back to the page under test. Without this the next control is
        // clicked on whatever the last one navigated to, and every transition
        // after the first is attributed to the wrong screen.
        await probe.open(`${options.baseUrl}${url}`);
      } catch (error) {
        incomplete = `stopped following controls on ${screen.route}: ${message(error)}`;
        break;
      }
    }
  }

  return {
    at: new Date().toISOString(),
    baseUrl: options.baseUrl,
    attempted,
    visits,
    transitions,
    ...(incomplete ? { incomplete } : {}),
  };
}

/**
 * Substitute concrete values into a dynamic route.
 *
 * Returns nothing when a segment has no value, which is what keeps the route
 * out of `attempted` rather than visiting a URL with `[id]` in it.
 */
export function concretize(
  route: string,
  params: Record<string, string>,
): string | undefined {
  const segments = route.split("/");
  const filled: string[] = [];

  for (const segment of segments) {
    const match = /^\[(\.\.\.)?(.+)\]$/.exec(segment);
    if (!match) {
      filled.push(segment);
      continue;
    }
    const value = params[match[2]!];
    if (value === undefined) return undefined;
    filled.push(value);
  }

  return filled.join("/") || "/";
}

function isDestructive(name: string, markers: readonly string[]): boolean {
  const lowered = name.toLowerCase();
  return markers.some((marker) => lowered.includes(marker));
}

function depth(route: string): number {
  return route.split("/").filter((segment) => segment.length > 0).length;
}

/** Reduce an absolute URL to a path, so observations compare against routes. */
function pathOf(url: string, baseUrl: string): string {
  const withoutBase = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
  if (withoutBase.startsWith("http")) {
    // An off-site navigation. Kept whole, because reducing it to a path would
    // make it look like a route in this app.
    return withoutBase;
  }
  return withoutBase === "" ? "/" : withoutBase;
}

function samePath(a: string, b: string): boolean {
  const strip = (value: string): string =>
    (value.split("?")[0]?.split("#")[0] ?? value).replace(/\/+$/, "") || "/";
  return strip(a) === strip(b);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
