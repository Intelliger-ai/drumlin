import { GraphView } from "@drumlin/core";
import {
  isOpen,
  routeToScreenId,
  withoutLocaleSegments,
  type GraphEdge,
  type GraphNode,
  type Issue,
  type NodeId,
} from "@drumlin/model";
import type { FlowLink, GraphFlowResult } from "./types.js";

/**
 * The graph around one screen.
 *
 * What an agent needs before it changes navigation, and the part of the IR that
 * is genuinely hard to reconstruct by reading files: inbound links live in
 * whatever imports the screen, which is exactly what a file-by-file reader
 * cannot see.
 */
export function flowFor(
  view: GraphView,
  route: string,
  issues: readonly Issue[] = [],
): GraphFlowResult {
  const screen = findScreen(view, route);
  if (!screen) {
    throw new Error(
      `No screen for ${route}. Run \`drumlin graph\` to see the known routes.`,
    );
  }

  return {
    screen,
    inbound: view
      .transitionsIn(screen.id)
      .map((edge) => toLink(view, edge, edge.from)),
    outbound: view
      .transitionsOut(screen.id)
      .map((edge) => toLink(view, edge, edge.to)),
    states: view.contained(screen.id, "State").map((state) => ({
      node: state.id,
      kind: state.stateKind ?? "unknown",
      inherited: state.properties?.["inherited"] === true,
    })),
    actions: view.contained(screen.id, "Action").map((action) => ({
      node: action.id,
      label: action.label ?? action.id,
      destructive: action.context?.destructive === true,
    })),
    issues: issues.filter(
      (issue) => isOpen(issue.status) && targetsNode(issue, screen.id),
    ),
  };
}

/**
 * Find a screen by whatever the caller had to hand.
 *
 * An agent will ask for `/invoices/123` having seen it in a browser, or
 * `screen.invoices.id` having read it from a finding, or `/en/pricing` when the
 * route on disk is `/[locale]/pricing`. All three should work.
 */
export function findScreen(
  view: GraphView,
  route: string,
): GraphNode | undefined {
  const direct = view.node(route as NodeId);
  if (direct?.type === "Screen") return direct;

  const normalized = normalizeRoute(route);
  const byId = view.node(routeToScreenId(normalized));
  if (byId?.type === "Screen") return byId;

  const exact = view.screens.find((screen) => screen.route === normalized);
  if (exact) return exact;

  const withoutLocale = withoutLocaleSegments(normalized);
  const localeless = view.screens.find(
    (screen) =>
      screen.route !== undefined &&
      withoutLocaleSegments(screen.route) === withoutLocale,
  );
  if (localeless) return localeless;

  // A concrete URL such as `/invoices/123` has to find `/invoices/[id]`.
  return view.screens.find(
    (screen) => screen.route !== undefined && matchesPattern(screen.route, normalized),
  );
}

function normalizeRoute(route: string): string {
  const withoutQuery = route.split(/[?#]/)[0] ?? route;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  if (trimmed.length === 0) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function matchesPattern(pattern: string, actual: string): boolean {
  const patternParts = pattern.split("/").filter(Boolean);
  const actualParts = actual.split("/").filter(Boolean);

  let index = 0;
  for (const part of patternParts) {
    if (part.startsWith("[...") || part.startsWith("[[...")) return true;
    const value = actualParts[index];
    if (value === undefined) return false;
    if (!part.startsWith("[") && part !== value) return false;
    index += 1;
  }
  return index === actualParts.length;
}

function toLink(view: GraphView, edge: GraphEdge, other: NodeId): FlowLink {
  const node = view.node(other);
  const source = edge.sources?.[0];

  const link: FlowLink = {
    route: node?.route ?? node?.label ?? other,
    node: other,
  };
  if (edge.label) link.kind = edge.label;
  if (edge.properties?.["chrome"] === true) link.chrome = true;
  if (edge.preserve && edge.preserve.length > 0) link.preserve = true;
  if (source?.file) link.file = source.file;
  if (source?.line !== undefined) link.line = source.line;
  return link;
}

function targetsNode(issue: Issue, id: NodeId): boolean {
  const target = issue.target;
  return target.node === id || target.from === id || target.to === id;
}
