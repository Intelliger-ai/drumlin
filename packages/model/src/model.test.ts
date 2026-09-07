import { describe, expect, test } from "vitest";
import {
  canTransition,
  checkGraphIntegrity,
  emptyGraph,
  findingFingerprint,
  IR_SCHEMA_VERSION,
  isOpen,
  issueId,
  nodeId,
  overrides,
  parseGraphDocument,
  parseIssueId,
  routeSegments,
  routeToScreenId,
  severityRank,
  slugify,
  stateId,
  targetKey,
  type Finding,
  type GraphDocument,
} from "./index.js";

describe("ids", () => {
  test("slugify normalizes camelCase and punctuation", () => {
    expect(slugify("InvoiceList")).toBe("invoice-list");
    expect(slugify("approve  invoices!")).toBe("approve-invoices");
    expect(slugify("bulkApproveInvoices")).toBe("bulk-approve-invoices");
    expect(slugify("__weird__")).toBe("weird");
  });

  test("nodeId namespaces and slugifies parts", () => {
    expect(nodeId("screen", "Invoice List")).toBe("screen.invoice-list");
    expect(nodeId("action", "approveInvoice")).toBe("action.approve-invoice");
    expect(nodeId("screen")).toBe("screen");
  });

  test("route groups do not affect screen identity", () => {
    // (dashboard) organises files without changing the URL, so two routes that
    // differ only by group must resolve to the same screen.
    expect(routeToScreenId("/(dashboard)/settings")).toBe(
      routeToScreenId("/settings"),
    );
  });

  test("dynamic segments collapse to their parameter name", () => {
    expect(routeToScreenId("/invoices/[id]")).toBe("screen.invoices.id");
    expect(routeToScreenId("/docs/[...slug]")).toBe("screen.docs.slug-catchall");
    expect(routeToScreenId("/shop/[[...all]]")).toBe(
      "screen.shop.all-optional-catchall",
    );
  });

  test("root route has a stable id", () => {
    expect(routeToScreenId("/")).toBe("screen.root");
    expect(routeSegments("/")).toEqual([]);
  });

  test("stateId nests beneath its screen without repeating the prefix", () => {
    expect(stateId("screen.invoices", "loading")).toBe(
      "state.invoices.loading",
    );
  });

  test("stateId preserves nesting depth of a dynamic route", () => {
    // Naively passing the dotted screen path through slugify collapses the
    // separator and yields state.invoices-id.loading.
    expect(stateId("screen.invoices.id", "loading")).toBe(
      "state.invoices.id.loading",
    );
  });

  test("issue ids pad so they sort lexically", () => {
    expect(issueId(184)).toBe("UX-0184");
    expect(issueId(7)).toBe("UX-0007");
    expect([issueId(9), issueId(10), issueId(100)].sort()).toEqual([
      "UX-0009",
      "UX-0010",
      "UX-0100",
    ]);
    expect(parseIssueId("UX-0184")).toBe(184);
    expect(parseIssueId("nope")).toBeUndefined();
  });
});

describe("provenance precedence", () => {
  test("human confirmation beats inference", () => {
    expect(overrides("human", "inferred")).toBe(true);
    expect(overrides("inferred", "human")).toBe(false);
  });

  test("a fresher run of the same source may overwrite", () => {
    expect(overrides("inferred", "inferred")).toBe(true);
  });

  test("runtime evidence beats an agent's assertion", () => {
    expect(overrides("runtime", "agent")).toBe(true);
    expect(overrides("agent", "runtime")).toBe(false);
  });
});

describe("graph document", () => {
  const doc: GraphDocument = {
    schemaVersion: IR_SCHEMA_VERSION,
    layer: "actual",
    nodes: [
      { id: "screen.invoices", type: "Screen", route: "/invoices" },
      { id: "state.invoices.filtered", type: "State", stateKind: "filtered" },
      { id: "action.open-invoice", type: "Action" },
      { id: "screen.invoices.id", type: "Screen", route: "/invoices/[id]" },
    ],
    edges: [
      {
        from: "screen.invoices",
        to: "state.invoices.filtered",
        type: "contains",
      },
      {
        from: "state.invoices.filtered",
        to: "screen.invoices.id",
        type: "transitions_to",
        via: "action.open-invoice",
        preserve: ["filters", "sort", "page"],
      },
    ],
  };

  test("survives a JSON round trip unchanged", () => {
    const parsed = parseGraphDocument(JSON.parse(JSON.stringify(doc)));
    expect(parsed).toEqual(doc);
  });

  test("rejects an unknown edge type", () => {
    const bad = { ...doc, edges: [{ ...doc.edges[0], type: "teleports_to" }] };
    expect(() => parseGraphDocument(bad)).toThrow();
  });

  test("rejects confidence outside 0..1", () => {
    const bad = {
      ...doc,
      nodes: [
        {
          ...doc.nodes[0],
          provenance: { source: "inferred", confidence: 1.5 },
        },
      ],
    };
    expect(() => parseGraphDocument(bad)).toThrow();
  });

  test("empty graph is valid", () => {
    expect(() => parseGraphDocument(emptyGraph())).not.toThrow();
  });

  test("integrity check accepts a well-formed document", () => {
    expect(checkGraphIntegrity(doc)).toEqual([]);
  });

  test("integrity check catches dangling edges and duplicate nodes", () => {
    const broken: GraphDocument = {
      ...doc,
      nodes: [...doc.nodes, { id: "screen.invoices", type: "Screen" }],
      edges: [
        ...doc.edges,
        { from: "screen.invoices", to: "screen.ghost", type: "transitions_to" },
        {
          from: "screen.invoices",
          to: "screen.invoices.id",
          type: "transitions_to",
          via: "action.missing",
        },
      ],
    };
    const kinds = checkGraphIntegrity(broken).map((p) => p.kind);
    expect(kinds).toContain("duplicate-node");
    expect(kinds).toContain("dangling-edge");
    expect(kinds).toContain("dangling-via");
  });
});

describe("findings", () => {
  const finding: Finding = {
    ruleId: "flow.error.missing-recovery",
    scope: "flow_edge",
    severity: "high",
    confidence: 0.98,
    classification: "graph",
    principles: ["teslers-law", "peak-end-rule"],
    target: {
      kind: "edge",
      from: "state.invoices.processing",
      to: "state.invoices.partial-failure",
    },
    evidence: [{ type: "graph", ref: "flow.invoice-approval" }],
    message: "Partial failure has no recovery path.",
  };

  test("severity ranks ascending", () => {
    expect(severityRank("info")).toBeLessThan(severityRank("critical"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
  });

  test("target keys are readable and distinguish shape", () => {
    expect(targetKey(finding.target)).toBe(
      "edge:state.invoices.processing->state.invoices.partial-failure",
    );
    expect(targetKey({ kind: "node", node: "screen.invoices" })).toBe(
      "node:screen.invoices",
    );
    expect(targetKey({ kind: "project" })).toBe("project");
  });

  test("fingerprint is stable across runs and free of line numbers", () => {
    const again = { ...finding, confidence: 0.5, severity: "low" as const };
    expect(findingFingerprint(again)).toBe(findingFingerprint(finding));
    expect(findingFingerprint(finding)).not.toMatch(/\d+:\d+/);
  });

  test("fingerprint separates different rules on the same target", () => {
    const other = { ...finding, ruleId: "flow.dead-end" };
    expect(findingFingerprint(other)).not.toBe(findingFingerprint(finding));
  });
});

describe("issue state machine", () => {
  test("only the verifier path reaches resolved", () => {
    expect(canTransition("verifying", "resolved")).toBe(true);
    expect(canTransition("candidate_resolved", "resolved")).toBe(false);
    expect(canTransition("in_progress", "resolved")).toBe(false);
  });

  test("a failed verification reopens rather than closing", () => {
    expect(canTransition("verifying", "reopened")).toBe(true);
    expect(canTransition("reopened", "assigned")).toBe(true);
  });

  test("superseded is terminal", () => {
    expect(canTransition("superseded", "confirmed")).toBe(false);
  });

  test("open excludes resolved and accepted", () => {
    expect(isOpen("detected")).toBe(true);
    expect(isOpen("reopened")).toBe(true);
    expect(isOpen("resolved")).toBe(false);
    expect(isOpen("accepted")).toBe(false);
  });
});
