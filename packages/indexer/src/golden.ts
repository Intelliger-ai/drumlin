import type { GraphDocument, GraphEdge, GraphNode } from "@drumlin/model";

/**
 * Compare an extracted `actual` graph against a hand-written `expected` one.
 *
 * Containment rather than equality, because the golden document is a human
 * statement of what the app should look like — not a snapshot of extractor
 * output. Extraction is free to discover more detail; it is not free to miss
 * or contradict what a person wrote down.
 */
export interface GoldenMismatch {
  kind: "missing-node" | "missing-edge" | "wrong-field";
  detail: string;
}

/** Fields on a node that the golden document is allowed to assert. */
const ASSERTED_NODE_FIELDS = [
  "type",
  "route",
  "router",
  "stateKind",
] as const satisfies ReadonlyArray<keyof GraphNode>;

export function compareToGolden(
  actual: GraphDocument,
  expected: GraphDocument,
): GoldenMismatch[] {
  const mismatches: GoldenMismatch[] = [];
  const actualNodes = new Map(actual.nodes.map((node) => [node.id, node]));

  for (const expectedNode of expected.nodes) {
    const actualNode = actualNodes.get(expectedNode.id);
    if (!actualNode) {
      mismatches.push({
        kind: "missing-node",
        detail: `${expectedNode.type} ${expectedNode.id}${
          expectedNode.route ? ` (${expectedNode.route})` : ""
        }`,
      });
      continue;
    }

    for (const field of ASSERTED_NODE_FIELDS) {
      const want = expectedNode[field];
      if (want === undefined) continue;
      const got = actualNode[field];
      if (got !== want) {
        mismatches.push({
          kind: "wrong-field",
          detail: `${expectedNode.id}.${field}: expected ${String(want)}, got ${String(got)}`,
        });
      }
    }

    // Context is asserted key by key, so a golden document can pin `async`
    // without having to specify every other contextual property.
    for (const [key, want] of Object.entries(expectedNode.context ?? {})) {
      const got = actualNode.context?.[key as keyof typeof actualNode.context];
      if (got !== want) {
        mismatches.push({
          kind: "wrong-field",
          detail: `${expectedNode.id}.context.${key}: expected ${String(want)}, got ${String(got)}`,
        });
      }
    }
  }

  const actualEdges = new Set(
    actual.edges.map((edge) => edgeKey(edge)),
  );

  for (const expectedEdge of expected.edges) {
    if (actualEdges.has(edgeKey(expectedEdge))) continue;
    mismatches.push({
      kind: "missing-edge",
      detail: `${expectedEdge.from} --${expectedEdge.type}--> ${expectedEdge.to}`,
    });
  }

  return mismatches;
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
}
