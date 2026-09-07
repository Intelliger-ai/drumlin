import { z } from "zod";
import { PropertiesSchema } from "./json.js";
import { NodeIdSchema } from "./ids.js";
import { ProvenanceSchema, SourceLocationSchema } from "./provenance.js";

/**
 * The UX Graph IR. A compiler-style intermediate representation of product
 * experience, deliberately independent of React, Vue, SwiftUI, or any design
 * tool — so a rule written once holds across frameworks.
 *
 * See vault/Graph/UX Graph IR.md and Context/04 UX Graph Intermediate Representation.md
 */

export const NODE_TYPES = [
  "Product",
  "Feature",
  "Persona",
  "Role",
  "UserStory",
  "Task",
  "Flow",
  "Screen",
  "State",
  "Component",
  "Action",
  "Decision",
  "SystemEvent",
  "Permission",
  "BusinessRule",
  "DataObject",
] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;

export const EDGE_TYPES = [
  "contains",
  "starts_at",
  "transitions_to",
  "triggered_by",
  "requires_permission",
  "implements_story",
  "uses_component",
  "reads_object",
  "writes_object",
  "preserves_context",
  "loses_context",
  "recovers_to",
  "supersedes",
  "conflicts_with",
  "validated_by",
  "supported_by",
] as const;

export const EdgeTypeSchema = z.enum(EDGE_TYPES);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

export const RISK_LEVELS = ["none", "low", "medium", "high", "critical"] as const;
export const RiskLevelSchema = z.enum(RISK_LEVELS);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const FREQUENCIES = [
  "rare",
  "occasional",
  "regular",
  "frequent",
  "constant",
] as const;
export const FrequencySchema = z.enum(FREQUENCIES);
export type Frequency = z.infer<typeof FrequencySchema>;

/** Canonical names for the states a data-driven screen is expected to have. */
export const STATE_KINDS = [
  "loading",
  "empty",
  "no-results",
  "error",
  "partial-failure",
  "success",
  "forbidden",
  "not-found",
  "filtered",
  "submitting",
] as const;
export const StateKindSchema = z.enum(STATE_KINDS);
export type StateKind = z.infer<typeof StateKindSchema>;

/**
 * Context carried on a node or transition. Rules read these rather than
 * re-deriving them, which is what lets one rule behave differently for an
 * expert operator and a first-run user.
 */
export const NodeContextSchema = z.object({
  roles: z.array(z.string()).optional(),
  frequency: FrequencySchema.optional(),
  risk: RiskLevelSchema.optional(),
  /** Relative interaction cost. Unitless; only comparisons are meaningful. */
  estimatedCost: z.number().nonnegative().optional(),
  reversible: z.boolean().optional(),
  destructive: z.boolean().optional(),
  async: z.boolean().optional(),
  /** Working state this node is required to preserve: filters, sort, page. */
  persists: z.array(z.string()).optional(),
});
export type NodeContext = z.infer<typeof NodeContextSchema>;

export const GraphNodeSchema = z.object({
  id: NodeIdSchema,
  type: NodeTypeSchema,
  /** Human-facing name. Display only — never identity. */
  label: z.string().optional(),
  /** Screens only: the URL path that reaches this node. */
  route: z.string().optional(),
  /** Which extractor produced this node, for mixed-router repositories. */
  router: z.enum(["app", "pages"]).optional(),
  /** States only: which of the canonical states this represents. */
  stateKind: StateKindSchema.optional(),
  context: NodeContextSchema.optional(),
  sources: z.array(SourceLocationSchema).optional(),
  provenance: ProvenanceSchema.optional(),
  properties: PropertiesSchema.optional(),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  from: NodeIdSchema,
  to: NodeIdSchema,
  type: EdgeTypeSchema,
  /** The action or event that carries this transition, when there is one. */
  via: NodeIdSchema.optional(),
  label: z.string().optional(),
  /** Working state this transition carries across, e.g. filters and sort. */
  preserve: z.array(z.string()).optional(),
  context: NodeContextSchema.optional(),
  sources: z.array(SourceLocationSchema).optional(),
  provenance: ProvenanceSchema.optional(),
  properties: PropertiesSchema.optional(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/**
 * Which of the three views a document represents.
 *
 * `actual` is inferred from implementation or observed at runtime, `expected`
 * is what the product contract requires, `proposed` is what a remediation plan
 * would make true. Diffing two layers is the primary interface.
 */
export const GRAPH_LAYERS = ["actual", "expected", "proposed"] as const;
export const GraphLayerSchema = z.enum(GRAPH_LAYERS);
export type GraphLayer = z.infer<typeof GraphLayerSchema>;

/** Bumped only by a breaking change to node or edge shape. */
export const IR_SCHEMA_VERSION = 1;

/**
 * The file-level module graph: each source file to the local files it imports.
 *
 * Carried on the document rather than recomputed because `check --changed` has
 * to answer "what else does this file affect" from a cached graph, where no
 * parsed source exists any more. Paths are relative to the workspace root, so
 * the map survives the repository being moved.
 */
export const ModuleGraphSchema = z.record(z.string(), z.array(z.string()));
export type ModuleGraph = z.infer<typeof ModuleGraphSchema>;

export const GraphDocumentSchema = z.object({
  schemaVersion: z.number().int().positive(),
  layer: GraphLayerSchema,
  /** Stable workspace identity: canonical repo path plus Git identity. */
  workspace: z
    .object({
      id: z.string(),
      root: z.string(),
      branch: z.string().optional(),
      commit: z.string().optional(),
    })
    .optional(),
  generatedAt: z.string().optional(),
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  imports: ModuleGraphSchema.optional(),
});
export type GraphDocument = z.infer<typeof GraphDocumentSchema>;

export function emptyGraph(layer: GraphLayer = "actual"): GraphDocument {
  return {
    schemaVersion: IR_SCHEMA_VERSION,
    layer,
    nodes: [],
    edges: [],
  };
}

/** Parse and validate an IR document from untrusted JSON. Throws on invalid. */
export function parseGraphDocument(input: unknown): GraphDocument {
  return GraphDocumentSchema.parse(input);
}

/**
 * Structural problems that make a document unsafe to run rules against.
 *
 * Distinct from rule findings: these are defects in the graph itself, so a
 * caller should refuse to report UX issues until they are resolved.
 */
export interface GraphIntegrityProblem {
  kind: "duplicate-node" | "dangling-edge" | "dangling-via" | "self-edge";
  detail: string;
}

export function checkGraphIntegrity(
  doc: GraphDocument,
): GraphIntegrityProblem[] {
  const problems: GraphIntegrityProblem[] = [];
  const seen = new Set<string>();

  for (const node of doc.nodes) {
    if (seen.has(node.id)) {
      problems.push({
        kind: "duplicate-node",
        detail: `node ${node.id} declared more than once`,
      });
    }
    seen.add(node.id);
  }

  for (const edge of doc.edges) {
    if (!seen.has(edge.from)) {
      problems.push({
        kind: "dangling-edge",
        detail: `edge ${edge.type} from unknown node ${edge.from}`,
      });
    }
    if (!seen.has(edge.to)) {
      problems.push({
        kind: "dangling-edge",
        detail: `edge ${edge.type} to unknown node ${edge.to}`,
      });
    }
    if (edge.via !== undefined && !seen.has(edge.via)) {
      problems.push({
        kind: "dangling-via",
        detail: `edge ${edge.from} -> ${edge.to} via unknown node ${edge.via}`,
      });
    }
    if (edge.from === edge.to && edge.type === "contains") {
      problems.push({
        kind: "self-edge",
        detail: `node ${edge.from} contains itself`,
      });
    }
  }

  return problems;
}
