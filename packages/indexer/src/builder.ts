import {
  IR_SCHEMA_VERSION,
  type GraphDocument,
  type GraphEdge,
  type GraphLayer,
  type GraphNode,
  type NodeId,
} from "@drumlin/model";

/**
 * Accumulates IR while extraction runs.
 *
 * Deduplication matters more than it looks: two screens under one layout share
 * the same inherited loading state, and the same route can be reached from many
 * places. Without merging, the graph gains duplicates that later read as real
 * structural findings.
 */
export class GraphBuilder {
  private readonly nodes = new Map<NodeId, GraphNode>();
  private readonly edges = new Map<string, GraphEdge>();

  addNode(node: GraphNode): GraphNode {
    const existing = this.nodes.get(node.id);
    if (!existing) {
      this.nodes.set(node.id, node);
      return node;
    }
    const merged = mergeNodes(existing, node);
    this.nodes.set(node.id, merged);
    return merged;
  }

  hasNode(id: NodeId): boolean {
    return this.nodes.has(id);
  }

  getNode(id: NodeId): GraphNode | undefined {
    return this.nodes.get(id);
  }

  addEdge(edge: GraphEdge): void {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.type}\u0000${edge.via ?? ""}`;
    const existing = this.edges.get(key);
    if (!existing) {
      this.edges.set(key, edge);
      return;
    }
    this.edges.set(key, mergeEdges(existing, edge));
  }

  /**
   * Drop edges that point at nodes we never resolved.
   *
   * An href can name a route that does not exist, and a rule must not read that
   * as a graph structure problem. Returns the discarded edges so a caller can
   * report them as broken links instead.
   */
  pruneDanglingEdges(): GraphEdge[] {
    const dropped: GraphEdge[] = [];
    for (const [key, edge] of this.edges) {
      if (this.nodes.has(edge.from) && this.nodes.has(edge.to)) continue;
      dropped.push(edge);
      this.edges.delete(key);
    }
    return dropped;
  }

  build(
    layer: GraphLayer,
    workspace?: GraphDocument["workspace"],
  ): GraphDocument {
    const doc: GraphDocument = {
      schemaVersion: IR_SCHEMA_VERSION,
      layer,
      generatedAt: new Date().toISOString(),
      // Sorted so the same input always produces byte-identical output, which
      // is what makes the IR diffable and the cache trustworthy.
      nodes: [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...this.edges.values()].sort(compareEdges),
    };
    if (workspace) doc.workspace = workspace;
    return doc;
  }
}

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  return (
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    a.type.localeCompare(b.type) ||
    (a.via ?? "").localeCompare(b.via ?? "")
  );
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function mergeNodes(existing: GraphNode, incoming: GraphNode): GraphNode {
  const merged: GraphNode = { ...existing, ...incoming };

  merged.type = existing.type;
  if (existing.label && !incoming.label) merged.label = existing.label;

  const sources = [...(existing.sources ?? []), ...(incoming.sources ?? [])];
  if (sources.length > 0) {
    const seen = new Set<string>();
    merged.sources = sources.filter((source) => {
      const key = `${source.file}:${source.line ?? ""}:${source.symbol ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  if (existing.context || incoming.context) {
    merged.context = { ...existing.context, ...incoming.context };
    const persists = [
      ...(existing.context?.persists ?? []),
      ...(incoming.context?.persists ?? []),
    ];
    if (persists.length > 0) merged.context.persists = unique(persists).sort();
    const roles = [
      ...(existing.context?.roles ?? []),
      ...(incoming.context?.roles ?? []),
    ];
    if (roles.length > 0) merged.context.roles = unique(roles).sort();
  }

  if (existing.properties || incoming.properties) {
    merged.properties = { ...existing.properties, ...incoming.properties };
  }

  return merged;
}

function mergeEdges(existing: GraphEdge, incoming: GraphEdge): GraphEdge {
  const merged: GraphEdge = { ...existing, ...incoming };

  const sources = [...(existing.sources ?? []), ...(incoming.sources ?? [])];
  if (sources.length > 0) {
    const seen = new Set<string>();
    merged.sources = sources.filter((source) => {
      const key = `${source.file}:${source.line ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const preserve = [...(existing.preserve ?? []), ...(incoming.preserve ?? [])];
  if (preserve.length > 0) merged.preserve = unique(preserve).sort();

  if (existing.properties || incoming.properties) {
    merged.properties = { ...existing.properties, ...incoming.properties };
  }

  // Chrome is the weaker claim: if any real in-content link exists between two
  // screens, the pair is genuinely connected.
  const existingChrome = existing.properties?.["chrome"] === true;
  const incomingChrome = incoming.properties?.["chrome"] === true;
  if (merged.properties && (existingChrome || incomingChrome)) {
    merged.properties["chrome"] = existingChrome && incomingChrome;
  }

  // Describe the edge by its strongest evidence. A sidebar entry merging into a
  // real in-content link should not relabel it as navigation config.
  if (existingChrome !== incomingChrome) {
    const stronger = incomingChrome ? existing : incoming;
    merged.label = stronger.label;
    if (merged.properties && stronger.properties?.["kind"] !== undefined) {
      merged.properties["kind"] = stronger.properties["kind"];
    }
  }

  return merged;
}
