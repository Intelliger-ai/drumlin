import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphEdge, GraphNode } from "@drumlin/model";
import {
  identityNodes,
  identitySnapshot,
  matchGraphs,
  renameMap,
} from "./identity.js";
import { retargetIssues } from "../issues/retarget.js";
import type { Issue } from "@drumlin/model";

function graph(nodes: GraphNode[], edges: GraphEdge[] = []): GraphDocument {
  return { schemaVersion: 1, layer: "actual", nodes, edges };
}

function screen(
  id: string,
  route: string,
  file: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type: "Screen",
    route,
    sources: [{ file }],
    ...extra,
  };
}

function component(id: string, file: string, symbol: string): GraphNode {
  return { id, type: "Component", sources: [{ file, symbol }] };
}

function action(id: string, file: string, symbol: string): GraphNode {
  return { id, type: "Action", sources: [{ file, symbol }] };
}

function contains(from: string, to: string): GraphEdge {
  return { from, to, type: "contains" };
}

function transition(from: string, to: string): GraphEdge {
  return { from, to, type: "transitions_to" };
}

/**
 * Matching a new graph onto an old one.
 *
 * The stakes are asymmetric and the tests are weighted accordingly. Failing to
 * match loses a `UX-` number, which is annoying. Matching the wrong pair moves
 * an accepted issue onto a different screen and silences a real finding
 * somewhere nobody is looking. So roughly half of what follows checks that the
 * resolver declines to guess.
 */
describe("graph identity", () => {
  describe("the ordinary case", () => {
    it("anchors on identical ids without scoring anything", () => {
      const before = graph([screen("screen.invoices", "/invoices", "a.tsx")]);
      const after = graph([screen("screen.invoices", "/invoices", "a.tsx")]);

      const match = matchGraphs(before, after);

      expect(match.anchored).toHaveLength(1);
      expect(match.renamed).toHaveLength(0);
      expect(match.added).toHaveLength(0);
      expect(match.removed).toHaveLength(0);
    });

    it("reports a genuinely new screen as added", () => {
      const before = graph([screen("screen.invoices", "/invoices", "a.tsx")]);
      const after = graph([
        screen("screen.invoices", "/invoices", "a.tsx"),
        screen("screen.reports", "/reports", "b.tsx"),
      ]);

      const match = matchGraphs(before, after);

      expect(match.added.map((node) => node.id)).toEqual(["screen.reports"]);
      expect(match.removed).toHaveLength(0);
    });

    it("reports a deleted screen as removed", () => {
      const before = graph([
        screen("screen.invoices", "/invoices", "a.tsx"),
        screen("screen.reports", "/reports", "b.tsx"),
      ]);
      const after = graph([screen("screen.invoices", "/invoices", "a.tsx")]);

      const match = matchGraphs(before, after);

      expect(match.removed.map((node) => node.id)).toEqual(["screen.reports"]);
      expect(match.added).toHaveLength(0);
    });
  });

  describe("renames it should catch", () => {
    it("follows a component through a file move", () => {
      // The id embeds the path, so this is a rename as far as ids go. The
      // symbol is untouched, which is the strongest signal available.
      const before = graph([
        component(
          "component.src-components-table.tsx.Table",
          "src/components/table.tsx",
          "Table",
        ),
      ]);
      const after = graph([
        component(
          "component.src-ui-table.tsx.Table",
          "src/ui/table.tsx",
          "Table",
        ),
      ]);

      const match = matchGraphs(before, after);

      expect(match.renamed).toHaveLength(1);
      expect(match.renamed[0]).toMatchObject({
        before: "component.src-components-table.tsx.Table",
        after: "component.src-ui-table.tsx.Table",
      });
      expect(match.renamed[0]?.because).toContain("symbol");
    });

    it("follows an action that gained a file qualifier it never asked for", () => {
      // `actionIdFor` qualifies by path only on a name collision, so adding an
      // unrelated second `approve` elsewhere renames this node. Nothing about
      // this node changed at all.
      const before = graph([
        action("action.approve", "src/lib/a.ts", "approve"),
      ]);
      const after = graph([
        action("action.src-lib-a.ts.approve", "src/lib/a.ts", "approve"),
        action("action.src-lib-b.ts.approve", "src/lib/b.ts", "approve"),
      ]);

      const match = matchGraphs(before, after);

      expect(match.renamed[0]).toMatchObject({
        before: "action.approve",
        after: "action.src-lib-a.ts.approve",
      });
      // The file is what breaks the tie between two identically named actions.
      expect(match.renamed[0]?.because).toContain("file");
      expect(match.added.map((node) => node.id)).toEqual([
        "action.src-lib-b.ts.approve",
      ]);
    });

    it("follows a renamed symbol in a file that did not move", () => {
      const before = graph([
        action("action.approve-invoice", "src/lib/a.ts", "approveInvoice"),
      ]);
      const after = graph([
        action("action.approve", "src/lib/a.ts", "approve"),
      ]);

      const match = matchGraphs(before, after);

      expect(match.renamed).toHaveLength(1);
      expect(match.renamed[0]?.because).toEqual(
        expect.arrayContaining(["file", "symbol"]),
      );
    });

    it("follows a renamed route using its neighbourhood", () => {
      // The hard case, and the reason structural propagation exists: the route
      // changed and there is no symbol on a screen node, so the only evidence
      // left is that the same actions and the same inbound screen are attached.
      const before = graph(
        [
          screen("screen.root", "/", "app/page.tsx"),
          screen("screen.invoices", "/invoices", "app/invoices/page.tsx"),
          action("action.pay", "app/invoices/actions.ts", "pay"),
        ],
        [
          transition("screen.root", "screen.invoices"),
          contains("screen.invoices", "action.pay"),
        ],
      );
      const after = graph(
        [
          screen("screen.root", "/", "app/page.tsx"),
          screen("screen.bills", "/bills", "app/bills/page.tsx"),
          action("action.pay", "app/bills/actions.ts", "pay"),
        ],
        [
          transition("screen.root", "screen.bills"),
          contains("screen.bills", "action.pay"),
        ],
      );

      const match = matchGraphs(before, after);

      expect(match.renamed.map((entry) => [entry.before, entry.after])).toEqual(
        [["screen.invoices", "screen.bills"]],
      );
      expect(match.renamed[0]?.because).toContain("neighbourhood");
    });
  });

  describe("things it must refuse", () => {
    it("never matches across node types", () => {
      // A Screen does not become an Action, however similar the evidence.
      const before = graph([
        {
          id: "screen.pay",
          type: "Screen",
          route: "/pay",
          sources: [{ file: "a.ts", symbol: "pay" }],
        },
      ]);
      const after = graph([action("action.pay", "a.ts", "pay")]);

      const match = matchGraphs(before, after);

      expect(match.renamed).toHaveLength(0);
      expect(match.added).toHaveLength(1);
      expect(match.removed).toHaveLength(1);
    });

    it("does not match two unrelated screens that merely both exist", () => {
      const before = graph([
        screen("screen.invoices", "/invoices", "app/invoices/page.tsx"),
      ]);
      const after = graph([
        screen("screen.settings", "/settings", "app/settings/page.tsx"),
      ]);

      const match = matchGraphs(before, after);

      expect(match.renamed).toHaveLength(0);
      expect(match.added.map((node) => node.id)).toEqual(["screen.settings"]);
      expect(match.removed.map((node) => node.id)).toEqual(["screen.invoices"]);
    });

    it("refuses a near-tie instead of picking a winner", () => {
      // Two candidates that are equally plausible successors. The honest
      // answer is "I do not know", not whichever scored a hair higher.
      const before = graph([
        component("component.old.Table", "src/table.tsx", "Table"),
      ]);
      const after = graph([
        component("component.a.Table", "src/a/table.tsx", "Table"),
        component("component.b.Table", "src/b/table.tsx", "Table"),
      ]);

      const match = matchGraphs(before, after);

      expect(match.renamed).toHaveLength(0);
      expect(match.ambiguous.length).toBeGreaterThan(0);
      // Reported, not silently dropped.
      expect(match.ambiguous[0]?.before).toBe("component.old.Table");
    });

    it("does not match on a label alone", () => {
      // A label is display text the model explicitly refuses to treat as
      // identity. On its own it carries too little weight to clear support.
      const before = graph([
        { id: "component.x.A", type: "Component", label: "Table" },
      ]);
      const after = graph([
        { id: "component.y.B", type: "Component", label: "Table" },
      ]);

      const match = matchGraphs(before, after);

      expect(match.renamed).toHaveLength(0);
    });

    it("cannot tell a rename from a swap of one sibling for another", () => {
      // A known and accepted limit, recorded rather than hidden. Deleting
      // `/a` and adding `/b`, where both hang off root and nothing else
      // distinguishes them, is *evidentially identical* to renaming `/a` to
      // `/b` — the graph contains no fact that separates the two.
      //
      // Reported as a rename because that is the more useful guess when it is
      // right and no worse than add-plus-remove when it is wrong: the issue
      // moves to a screen with the same shape and the same neighbours. The
      // multi-candidate version of this is caught by the margin check and
      // comes back ambiguous instead.
      const before = graph(
        [
          screen("screen.root", "/", "app/page.tsx"),
          screen("screen.a", "/a", "app/a/page.tsx"),
        ],
        [transition("screen.root", "screen.a")],
      );
      const after = graph(
        [
          screen("screen.root", "/", "app/page.tsx"),
          screen("screen.b", "/b", "app/b/page.tsx"),
        ],
        [transition("screen.root", "screen.b")],
      );

      const match = matchGraphs(before, after);

      expect(match.renamed.map((entry) => [entry.before, entry.after])).toEqual(
        [["screen.a", "screen.b"]],
      );
      expect(match.renamed[0]?.because).toEqual(["neighbourhood"]);
    });

    it("keeps one-to-one: two old nodes cannot both become one new node", () => {
      const before = graph([
        component("component.a.Table", "src/a/table.tsx", "Table"),
        component("component.b.Table", "src/b/table.tsx", "Table"),
      ]);
      const after = graph([
        component("component.c.Table", "src/c/table.tsx", "Table"),
      ]);

      const match = matchGraphs(before, after);

      const claimed = match.renamed.map((entry) => entry.after);
      expect(new Set(claimed).size).toBe(claimed.length);
      expect(match.renamed.length).toBeLessThanOrEqual(1);
    });
  });

  describe("the projection", () => {
    it("keeps only what identity is allowed to depend on", () => {
      const nodes = identityNodes(
        graph([
          screen("screen.a", "/a", "app/a/page.tsx", {
            label: "Invoices",
            // Line numbers live in here. Letting properties into identity
            // would make an unrelated edit look like a different node.
            properties: { unboundedSelects: [{ line: 12 }] },
          }),
        ]),
      );

      expect(nodes[0]).toEqual({
        id: "screen.a",
        type: "Screen",
        route: "/a",
        label: "Invoices",
        symbols: [],
        files: ["app/a/page.tsx"],
        neighbours: [],
      });
    });

    it("records neighbours undirected", () => {
      // Which way a `contains` edge points is a fact about the schema. For
      // "is this the same node", adjacency is the signal.
      const nodes = identityNodes(
        graph(
          [screen("screen.a", "/a", "a.tsx"), action("action.p", "a.ts", "p")],
          [contains("screen.a", "action.p")],
        ),
      );

      expect(nodes.find((n) => n.id === "screen.a")?.neighbours).toEqual([
        "action.p",
      ]);
      expect(nodes.find((n) => n.id === "action.p")?.neighbours).toEqual([
        "screen.a",
      ]);
    });

    it("round-trips through a snapshot", () => {
      // A snapshot is what gets persisted as a baseline, so matching against
      // one has to give the same answer as matching against a live graph.
      const before = graph([
        component(
          "component.src-a-table.tsx.Table",
          "src/a/table.tsx",
          "Table",
        ),
      ]);
      const after = graph([
        component(
          "component.src-b-table.tsx.Table",
          "src/b/table.tsx",
          "Table",
        ),
      ]);

      const viaSnapshot = matchGraphs(
        JSON.parse(JSON.stringify(identitySnapshot(before))),
        after,
      );

      expect(viaSnapshot.renamed).toEqual(matchGraphs(before, after).renamed);
    });
  });
});

/**
 * The reason any of the above matters.
 *
 * Issue identity is built on node identity, so without retargeting a route
 * rename retires the `UX-` number and drops the acceptance decision with it.
 */
describe("retargeting issues through a rename", () => {
  const issue: Issue = {
    id: "UX-0004",
    fingerprint: "state.route.no-error|node:screen.invoices",
    status: "accepted",
    severity: "high",
    confidence: 0.85,
    classification: "deterministic",
    rule: { id: "state.route.no-error" },
    target: { kind: "node", node: "screen.invoices", route: "/invoices" },
    evidence: [{ type: "graph", ref: "screen.invoices" }],
    message: "The invoices screen has no error state.",
    acceptedReason: "handled by the parent boundary",
    detectedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const renamed = matchGraphs(
    graph(
      [
        screen("screen.root", "/", "app/page.tsx"),
        screen("screen.invoices", "/invoices", "app/invoices/page.tsx"),
        action("action.pay", "app/invoices/actions.ts", "pay"),
      ],
      [
        transition("screen.root", "screen.invoices"),
        contains("screen.invoices", "action.pay"),
      ],
    ),
    graph(
      [
        screen("screen.root", "/", "app/page.tsx"),
        screen("screen.bills", "/bills", "app/bills/page.tsx"),
        action("action.pay", "app/bills/actions.ts", "pay"),
      ],
      [
        transition("screen.root", "screen.bills"),
        contains("screen.bills", "action.pay"),
      ],
    ),
  );

  it("moves the fingerprint onto the new node id", () => {
    const { issues, moved } = retargetIssues([issue], renamed);

    expect(issues[0]?.fingerprint).toBe(
      "state.route.no-error|node:screen.bills",
    );
    expect(issues[0]?.target.node).toBe("screen.bills");
    expect(moved).toEqual([
      {
        id: "UX-0004",
        from: "state.route.no-error|node:screen.invoices",
        to: "state.route.no-error|node:screen.bills",
      },
    ]);
  });

  it("keeps the UX number and the acceptance", () => {
    // The whole point. Renaming a route must not un-accept anything.
    const { issues } = retargetIssues([issue], renamed);

    expect(issues[0]?.id).toBe("UX-0004");
    expect(issues[0]?.status).toBe("accepted");
    expect(issues[0]?.acceptedReason).toBe("handled by the parent boundary");
  });

  it("leaves an unaffected issue completely alone", () => {
    const elsewhere: Issue = {
      ...issue,
      id: "UX-0005",
      fingerprint: "flow.orphan|node:screen.root",
      rule: { id: "flow.orphan" },
      target: { kind: "node", node: "screen.root" },
    };

    const { issues, moved } = retargetIssues([elsewhere], renamed);

    expect(issues[0]).toBe(elsewhere);
    expect(moved).toHaveLength(0);
  });

  it("rewrites both ends of an edge target", () => {
    const edgeIssue: Issue = {
      ...issue,
      fingerprint:
        "context.navigation.drops-search-params|edge:screen.root->screen.invoices",
      rule: { id: "context.navigation.drops-search-params" },
      target: { kind: "edge", from: "screen.root", to: "screen.invoices" },
    };

    const { issues } = retargetIssues([edgeIssue], renamed);

    expect(issues[0]?.target.to).toBe("screen.bills");
    // `screen.root` was anchored, not renamed, so it is untouched.
    expect(issues[0]?.target.from).toBe("screen.root");
  });

  it("does not touch a route target, which is not a node id", () => {
    // A route that changed is a different route. Rewriting it from the node
    // rename map would be guessing outside the evidence.
    const routeIssue: Issue = {
      ...issue,
      fingerprint: "flow.orphan|route:/invoices",
      target: { kind: "route", route: "/invoices" },
    };

    expect(retargetIssues([routeIssue], renamed).moved).toHaveLength(0);
  });

  it("ignores ambiguous candidates entirely", () => {
    const ambiguous = matchGraphs(
      graph([component("component.old.Table", "src/table.tsx", "Table")]),
      graph([
        component("component.a.Table", "src/a/table.tsx", "Table"),
        component("component.b.Table", "src/b/table.tsx", "Table"),
      ]),
    );

    expect(ambiguous.ambiguous.length).toBeGreaterThan(0);
    expect(renameMap(ambiguous).size).toBe(0);
  });
});
