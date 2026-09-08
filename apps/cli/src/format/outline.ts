import type { GraphDocument, GraphEdge, GraphNode } from "@drumlin/model";

/**
 * A readable outline of the IR.
 *
 * This exists to be eyeballed against the real application before any rule is
 * written. If the graph is wrong, every rule built on it is wrong and there is
 * no way to tell which — so the outline has to show enough to spot a bad
 * extraction, not just prove one ran.
 */

export interface OutlineOptions {
  /** Cap on screens listed. Large apps are unreadable in full. */
  limit?: number;
}

export function renderOutline(
  graph: GraphDocument,
  options: OutlineOptions = {},
): string {
  const lines: string[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    push(outgoing, edge.from, edge);
    push(incoming, edge.to, edge);
  }

  const screens = graph.nodes
    .filter((node) => node.type === "Screen")
    .sort((a, b) => (a.route ?? a.id).localeCompare(b.route ?? b.id));

  const limit = options.limit ?? screens.length;
  const shown = screens.slice(0, limit);

  for (const screen of shown) {
    lines.push("");
    lines.push(`${screen.route ?? screen.id}${screenBadges(screen)}`);
    lines.push(`  ${dim(screen.id)}`);

    const source = screen.sources?.[0];
    if (source) lines.push(`  ${dim(source.file)}`);

    const searchParams = asStringArray(screen.properties?.["searchParamKeys"]);
    if (searchParams.length > 0) {
      lines.push(`  reads searchParams: ${searchParams.join(", ")}`);
    }

    const dataEvidence = asStringArray(screen.properties?.["dataEvidence"]);
    if (dataEvidence.length > 0) {
      lines.push(`  data: ${dataEvidence.slice(0, 3).join("; ")}`);
    }

    const contains = outgoing.get(screen.id) ?? [];

    const states = contains
      .filter((edge) => byId.get(edge.to)?.type === "State")
      .map((edge) => {
        const node = byId.get(edge.to)!;
        const inherited = edge.properties?.["inherited"] === true;
        return `${node.stateKind ?? "state"}${inherited ? " (inherited)" : ""}`;
      });
    lines.push(
      states.length > 0
        ? `  states: ${states.sort().join(", ")}`
        : `  states: ${dim("none")}`,
    );

    const actions = contains
      .filter((edge) => byId.get(edge.to)?.type === "Action")
      .map((edge) => {
        const node = byId.get(edge.to)!;
        return `${node.label ?? node.id}${node.context?.destructive ? " [destructive]" : ""}`;
      });
    if (actions.length > 0) {
      lines.push(`  actions: ${actions.sort().join(", ")}`);
    }

    const transitions = contains.filter(
      (edge) => edge.type === "transitions_to",
    );
    const inContent = transitions.filter(
      (edge) => edge.properties?.["chrome"] !== true,
    );
    const chrome = transitions.filter(
      (edge) => edge.properties?.["chrome"] === true,
    );

    for (const edge of inContent.sort(byTarget)) {
      const target = byId.get(edge.to);
      lines.push(
        `  -> ${target?.route ?? edge.to} ${dim(
          `(${String(edge.properties?.["kind"] ?? edge.label ?? "link")}${describePreserve(edge)})`,
        )}`,
      );
    }
    if (chrome.length > 0) {
      lines.push(
        `  ${dim(`chrome -> ${chrome.length} destination${chrome.length === 1 ? "" : "s"}`)}`,
      );
    }
    if (inContent.length === 0) {
      lines.push(`  ${dim("no in-content transitions out")}`);
    }

    const inbound = (incoming.get(screen.id) ?? []).filter(
      (edge) => edge.type === "transitions_to",
    );
    const inboundInContent = inbound.filter(
      (edge) => edge.properties?.["chrome"] !== true,
    );
    lines.push(
      `  ${dim(
        `inbound: ${inboundInContent.length} in-content, ${
          inbound.length - inboundInContent.length
        } chrome`,
      )}`,
    );

    const selects = screen.properties?.["unboundedSelects"];
    if (Array.isArray(selects) && selects.length > 0) {
      lines.push(`  unbounded selects: ${selects.length}`);
    }
  }

  if (screens.length > shown.length) {
    lines.push("");
    lines.push(
      dim(`… ${screens.length - shown.length} more screens (raise --limit)`),
    );
  }

  const orphanComponents = graph.nodes.filter(
    (node) =>
      node.type === "Component" &&
      node.properties?.["duplicatesPrimitive"] !== undefined,
  );
  if (orphanComponents.length > 0) {
    lines.push("");
    lines.push("Components duplicating a design-system primitive:");
    for (const component of orphanComponents) {
      lines.push(
        `  ${component.label} ${dim(
          `${component.sources?.[0]?.file ?? ""} -> ${String(
            component.properties?.["duplicatesPrimitive"],
          )}`,
        )}`,
      );
    }
  }

  return lines.join("\n");
}

export function renderGraphSummary(graph: GraphDocument): string {
  const counts = new Map<string, number>();
  for (const node of graph.nodes) {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([type, count]) =>
        `${count} ${type.toLowerCase()}${count === 1 ? "" : "s"}`,
    );
  return `${parts.join(" · ")} · ${graph.edges.length} edges`;
}

function screenBadges(screen: GraphNode): string {
  const badges: string[] = [];
  if (screen.router) badges.push(screen.router);
  if (screen.context?.async) badges.push("async");
  if (screen.properties?.["clientComponent"] === true) badges.push("client");
  return badges.length > 0 ? `  ${dim(`[${badges.join(", ")}]`)}` : "";
}

function describePreserve(edge: GraphEdge): string {
  if (edge.properties?.["forwardsSearchParams"] === true) {
    return ", forwards params";
  }
  const preserve = edge.preserve ?? [];
  return preserve.length > 0 ? `, keeps ${preserve.join("+")}` : "";
}

function byTarget(a: GraphEdge, b: GraphEdge): number {
  return a.to.localeCompare(b.to);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** ANSI dim, dropped when stdout is not a TTY so piped output stays clean. */
export function dim(text: string): string {
  return process.stdout.isTTY ? `\u001B[2m${text}\u001B[22m` : text;
}
