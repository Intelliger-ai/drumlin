import type {
  GraphDocument,
  GraphEdge,
  GraphNode,
  NodeId,
  NodeType,
  StateKind,
} from "@drumlin/model";

/**
 * An indexed, read-only view over an IR document.
 *
 * Rules ask structural questions thousands of times per run, so adjacency is
 * built once here. Nothing in this file touches the filesystem or the parser:
 * everything a rule needs must already be on the IR, which is what keeps this
 * package portable per DEC-0001.
 */
export class GraphView {
  private readonly nodesById = new Map<NodeId, GraphNode>();
  private readonly nodesByType = new Map<NodeType, GraphNode[]>();
  private readonly outgoingByNode = new Map<NodeId, GraphEdge[]>();
  private readonly incomingByNode = new Map<NodeId, GraphEdge[]>();
  private readonly nodesByRoute = new Map<string, GraphNode[]>();

  constructor(readonly document: GraphDocument) {
    for (const node of document.nodes) {
      this.nodesById.set(node.id, node);
      const bucket = this.nodesByType.get(node.type);
      if (bucket) bucket.push(node);
      else this.nodesByType.set(node.type, [node]);
      if (node.route) push(this.nodesByRoute, node.route, node);
    }

    for (const edge of document.edges) {
      push(this.outgoingByNode, edge.from, edge);
      push(this.incomingByNode, edge.to, edge);
    }
  }

  node(id: NodeId): GraphNode | undefined {
    return this.nodesById.get(id);
  }

  /**
   * Nodes at a route.
   *
   * A second lookup key rather than a convenience. Findings and evidence
   * identify screens by route about as often as by node id — a route-section
   * rollup cites `/portal/audit`, not `screen.portal.audit` — and code that
   * only resolves ids silently loses those, which shows up much later as an
   * issue packet naming two of the eight files it is about.
   */
  atRoute(route: string): readonly GraphNode[] {
    return this.nodesByRoute.get(route) ?? [];
  }

  /**
   * Resolve a reference that may be either a node id or a route.
   *
   * Evidence `ref` is a loosely typed string by design, so the only safe
   * reading is to try both.
   */
  resolve(ref: string): readonly GraphNode[] {
    const byId = this.nodesById.get(ref);
    if (byId) return [byId];
    return this.atRoute(ref);
  }

  nodesOfType(type: NodeType): readonly GraphNode[] {
    return this.nodesByType.get(type) ?? [];
  }

  get screens(): readonly GraphNode[] {
    return this.nodesOfType("Screen");
  }

  outgoing(id: NodeId): readonly GraphEdge[] {
    return this.outgoingByNode.get(id) ?? [];
  }

  incoming(id: NodeId): readonly GraphEdge[] {
    return this.incomingByNode.get(id) ?? [];
  }

  /**
   * Transitions out of a node.
   *
   * `chrome` transitions come from a layout or shared navigation. They count for
   * reachability — the user really can click them — but not as a way onward from
   * a specific screen, since a global nav is present everywhere and would make
   * every dead end disappear.
   */
  transitionsOut(id: NodeId, options: { chrome?: boolean } = {}): GraphEdge[] {
    return this.outgoing(id).filter(
      (edge) =>
        edge.type === "transitions_to" && matchesChrome(edge, options.chrome),
    );
  }

  transitionsIn(id: NodeId, options: { chrome?: boolean } = {}): GraphEdge[] {
    return this.incoming(id).filter(
      (edge) =>
        edge.type === "transitions_to" && matchesChrome(edge, options.chrome),
    );
  }

  /** Nodes of a type contained by this node. */
  contained(id: NodeId, type: NodeType): GraphNode[] {
    const found: GraphNode[] = [];
    for (const edge of this.outgoing(id)) {
      if (edge.type !== "contains") continue;
      const node = this.nodesById.get(edge.to);
      if (node?.type === type) found.push(node);
    }
    return found;
  }

  /** True when a screen declares or inherits a given UX state. */
  hasState(id: NodeId, kind: StateKind): boolean {
    return this.contained(id, "State").some((node) => node.stateKind === kind);
  }

  /** Actions reachable from a screen. */
  actionsOf(id: NodeId): GraphNode[] {
    return this.contained(id, "Action");
  }

  /** A stable, readable label for reports. */
  labelOf(id: NodeId): string {
    const node = this.nodesById.get(id);
    return node?.route ?? node?.label ?? id;
  }
}

function matchesChrome(edge: GraphEdge, chrome: boolean | undefined): boolean {
  if (chrome === undefined) return true;
  return (edge.properties?.["chrome"] === true) === chrome;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}
