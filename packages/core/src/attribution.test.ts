import { describe, expect, it } from "vitest";
import { emptyGraph, type Finding, type GraphDocument } from "@drumlin/model";
import { attributeFindings, dependentCone, findingFiles } from "./index.js";
import { GraphView } from "./graph/view.js";

/**
 * The behaviour under test is DEC-0003: attribution narrows the report and
 * never the analysis. The last test in this file is the one that matters —
 * if a whole-graph finding stops being attributable, `--changed` starts
 * hiding orphans and the output looks healthier for it.
 */

function graphWith(
  imports: Record<string, string[]>,
  nodes: GraphDocument["nodes"] = [],
): GraphDocument {
  return { ...emptyGraph(), imports, nodes };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: "flow.orphan",
    scope: "screen",
    severity: "high",
    confidence: 0.9,
    classification: "graph",
    target: { kind: "node", node: "screen.invoices.id" },
    evidence: [],
    message: "Nothing links to this screen.",
    ...overrides,
  };
}

describe("dependentCone", () => {
  it("includes the changed file itself", () => {
    const cone = dependentCone({}, ["src/app/page.tsx"]);
    expect([...cone]).toEqual(["src/app/page.tsx"]);
  });

  it("walks importers, not imports", () => {
    // page imports Sidebar imports Icon. Editing Sidebar affects page, and
    // says nothing about Icon.
    const imports = {
      "src/app/page.tsx": ["src/components/sidebar.tsx"],
      "src/components/sidebar.tsx": ["src/components/icon.tsx"],
    };

    const cone = dependentCone(imports, ["src/components/sidebar.tsx"]);

    expect(cone.has("src/app/page.tsx")).toBe(true);
    expect(cone.has("src/components/icon.tsx")).toBe(false);
  });

  it("follows importers transitively", () => {
    const imports = {
      "a.tsx": ["b.tsx"],
      "b.tsx": ["c.tsx"],
      "c.tsx": ["d.tsx"],
    };
    expect([...dependentCone(imports, ["d.tsx"])].sort()).toEqual([
      "a.tsx",
      "b.tsx",
      "c.tsx",
      "d.tsx",
    ]);
  });

  it("terminates on an import cycle", () => {
    const imports = { "a.tsx": ["b.tsx"], "b.tsx": ["a.tsx"] };
    expect([...dependentCone(imports, ["a.tsx"])].sort()).toEqual([
      "a.tsx",
      "b.tsx",
    ]);
  });

  it("survives a graph with no module map", () => {
    expect([...dependentCone(undefined, ["a.tsx"])]).toEqual(["a.tsx"]);
  });
});

describe("findingFiles", () => {
  it("reads evidence locations", () => {
    const view = new GraphView(graphWith({}));
    const files = findingFiles(
      finding({
        evidence: [{ type: "source", location: { file: "src/app/page.tsx", line: 4 } }],
      }),
      view,
    );
    expect([...files]).toEqual(["src/app/page.tsx"]);
  });

  /**
   * The case that makes graph rules attributable at all. An orphan's evidence
   * is the absence of an inbound edge, so it cites a node rather than a line,
   * and the only route back to a file is through the node's own sources.
   */
  it("resolves a node target back to its source files", () => {
    const view = new GraphView(
      graphWith({}, [
        {
          id: "screen.invoices.id",
          type: "Screen",
          route: "/invoices/[id]",
          sources: [{ file: "src/app/invoices/[id]/page.tsx" }],
        },
      ]),
    );

    const files = findingFiles(
      finding({ evidence: [{ type: "graph", ref: "screen.invoices.id" }] }),
      view,
    );

    expect([...files]).toEqual(["src/app/invoices/[id]/page.tsx"]);
  });
});

describe("attributeFindings", () => {
  const view = new GraphView(
    graphWith({}, [
      {
        id: "screen.invoices.id",
        type: "Screen",
        sources: [{ file: "src/app/invoices/[id]/page.tsx" }],
      },
      {
        id: "screen.settings",
        type: "Screen",
        sources: [{ file: "src/app/settings/page.tsx" }],
      },
    ]),
  );

  it("keeps findings inside the cone and sets the rest aside", () => {
    const inside = finding({ target: { kind: "node", node: "screen.invoices.id" } });
    const outside = finding({ target: { kind: "node", node: "screen.settings" } });

    const result = attributeFindings(
      [inside, outside],
      new Set(["src/app/invoices/[id]/page.tsx"]),
      view,
    );

    expect(result.attributed).toEqual([inside]);
    expect(result.elsewhere).toEqual([outside]);
  });

  /**
   * Being unable to place a problem is a reason to show it, not to hide it.
   * A project-scoped finding has no file by construction.
   */
  it("reports a finding it cannot place rather than dropping it", () => {
    const unplaceable = finding({
      target: { kind: "project" },
      evidence: [{ type: "context", note: "no design system detected" }],
    });

    const result = attributeFindings([unplaceable], new Set(["anything.tsx"]), view);

    expect(result.attributed).toEqual([unplaceable]);
    expect(result.elsewhere).toEqual([]);
  });

  it("attributes an orphan to the screen it is about", () => {
    // The regression this guards: if a graph-classified finding stopped
    // resolving to a file, `--changed` would silently stop reporting orphans
    // and dead ends — half the Milestone A rule set.
    const orphan = finding({
      ruleId: "flow.orphan",
      classification: "graph",
      evidence: [{ type: "graph", ref: "screen.invoices.id" }],
      target: { kind: "node", node: "screen.invoices.id" },
    });

    const result = attributeFindings(
      [orphan],
      dependentCone(
        { "src/app/invoices/[id]/page.tsx": ["src/lib/api.ts"] },
        ["src/app/invoices/[id]/page.tsx"],
      ),
      view,
    );

    expect(result.attributed).toHaveLength(1);
  });
});
