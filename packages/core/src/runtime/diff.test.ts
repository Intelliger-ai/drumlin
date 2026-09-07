import { describe, expect, it } from "vitest";
import { parseGraphDocument } from "@drumlin/model";
import type { GraphDocument, ObservedGraph, ObservedVisit } from "@drumlin/model";
import { diffObserved, RUNTIME_RULES } from "./diff.js";

/**
 * Expected versus observed.
 *
 * Most of these tests are about restraint rather than detection. A runtime diff
 * has one dominant failure mode: reporting the harness's own coverage gaps as
 * product defects. The harness visits a handful of routes, and everything it
 * did not open, could not provoke, or never clicked is unknown — so the
 * interesting question for almost every check is what it does *not* say.
 */

/**
 * A two-screen app: `/invoices` links to `/invoices/[id]`.
 *
 * Parsed rather than cast. A cast fixture silently drifts from the schema —
 * this one had invented an `id` on every edge and was missing `layer`, and the
 * tests passed anyway because nothing read those fields. Parsing means the
 * fixture is a real document or the test fails saying so.
 */
function graph(): GraphDocument {
  return parseGraphDocument({
    schemaVersion: 1,
    layer: "expected",
    nodes: [
      { id: "screen.invoices", type: "Screen", route: "/invoices", label: "/invoices" },
      {
        id: "screen.invoices.$id",
        type: "Screen",
        route: "/invoices/[id]",
        label: "/invoices/[id]",
      },
      {
        id: "state.invoices.loading",
        type: "State",
        stateKind: "loading",
        label: "loading",
      },
      { id: "state.invoices.error", type: "State", stateKind: "error", label: "error" },
    ],
    edges: [
      {
        from: "screen.invoices",
        to: "screen.invoices.$id",
        type: "transitions_to",
      },
      { from: "screen.invoices", to: "state.invoices.loading", type: "contains" },
      { from: "screen.invoices", to: "state.invoices.error", type: "contains" },
    ],
  });
}

function visit(overrides: Partial<ObservedVisit> = {}): ObservedVisit {
  return {
    route: "/invoices",
    requested: "/invoices",
    settled: "/invoices",
    via: "visit",
    states: [],
    controls: [],
    errors: [],
    ...overrides,
  };
}

function run(overrides: Partial<ObservedGraph> = {}): ObservedGraph {
  return {
    at: "2026-09-06T00:00:00.000Z",
    baseUrl: "http://localhost:3000",
    attempted: [],
    visits: [],
    transitions: [],
    ...overrides,
  };
}

describe("diffObserved", () => {
  describe("coverage", () => {
    it("says nothing about a run that visited nothing", () => {
      // The most important test here. An empty observation must not condemn
      // every screen in the graph as unreachable.
      expect(diffObserved(graph(), run())).toEqual([]);
    });

    it("says nothing about routes the harness never attempted", () => {
      const findings = diffObserved(
        graph(),
        run({ attempted: ["/invoices"], visits: [visit()] }),
      );

      // `/invoices/[id]` was not attempted, so its silence means nothing.
      for (const finding of findings) {
        expect(finding.target.route).not.toBe("/invoices/[id]");
      }
    });

    it("reports a screen that was attempted and never rendered", () => {
      const findings = diffObserved(
        graph(),
        run({ attempted: ["/invoices"], visits: [] }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe(RUNTIME_RULES.unreachable);
      expect(findings[0]?.target.node).toBe("screen.invoices");
      expect(findings[0]?.severity).toBe("critical");
    });
  });

  describe("redirects", () => {
    it("reports a route that settles somewhere else", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [visit({ requested: "/invoices", settled: "/login" })],
        }),
      );

      const redirect = findings.find((f) => f.ruleId === RUNTIME_RULES.redirected);
      expect(redirect).toBeDefined();
      expect(redirect?.message).toContain("/login");
      expect(redirect?.severity).toBe("high");
    });

    it("does not check states on a page that redirected away", () => {
      // The page we landed on is a different page. Reporting `/invoices`'s
      // loading state as missing, when we were looking at `/login`, would be
      // a finding about the wrong screen.
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [visit({ settled: "/login", states: [] })],
        }),
      );

      expect(findings).toHaveLength(1);
      expect(findings[0]?.ruleId).toBe(RUNTIME_RULES.redirected);
    });

    it("ignores trailing slashes and query strings", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [
            visit({
              requested: "/invoices",
              settled: "/invoices/?page=2",
              states: ["loading"],
            }),
          ],
        }),
      );

      // Not a redirect. A pagination query and a trailing slash are the same
      // screen, and calling them a redirect would make the check unusable.
      expect(findings.filter((f) => f.ruleId === RUNTIME_RULES.redirected)).toEqual([]);
    });
  });

  describe("states", () => {
    it("reports a declared loading state that never appeared", () => {
      const findings = diffObserved(
        graph(),
        run({ attempted: ["/invoices"], visits: [visit({ states: [] })] }),
      );

      const missing = findings.find((f) => f.ruleId === RUNTIME_RULES.missingState);
      expect(missing?.target.node).toBe("state.invoices.loading");
    });

    it("stays quiet once the state has been seen", () => {
      const findings = diffObserved(
        graph(),
        run({ attempted: ["/invoices"], visits: [visit({ states: ["loading"] })] }),
      );

      expect(findings.filter((f) => f.ruleId === RUNTIME_RULES.missingState)).toEqual([]);
    });

    it("never reports an error state as missing", () => {
      // The restraint that makes this check usable. A harness cannot make a
      // server fail on demand, so an unseen error state is our limitation, not
      // the product's. Reporting it would mean every screen with an error
      // boundary carries a permanent false finding.
      const findings = diffObserved(
        graph(),
        run({ attempted: ["/invoices"], visits: [visit({ states: ["loading"] })] }),
      );

      for (const finding of findings) {
        expect(finding.target.node).not.toBe("state.invoices.error");
      }
    });
  });

  describe("transitions", () => {
    it("reports a click that went somewhere the source does not describe", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [visit({ states: ["loading"] })],
          transitions: [
            { from: "/invoices", to: "/dashboard", kind: "click", via: "INV-1" },
          ],
        }),
      );

      const broken = findings.find(
        (f) => f.ruleId === RUNTIME_RULES.brokenTransition,
      );
      expect(broken).toBeDefined();
      expect(broken?.message).toContain("/dashboard");
      // The expectation has to be in the message, or the finding is unactionable.
      expect(broken?.message).toContain("/invoices/[id]");
      expect(broken?.evidence.some((e) => e.note?.includes("INV-1"))).toBe(true);
    });

    it("accepts a click that matches the source", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [visit({ states: ["loading"] })],
          transitions: [
            { from: "/invoices", to: "/invoices/[id]", kind: "click", via: "INV-1" },
          ],
        }),
      );

      expect(
        findings.filter((f) => f.ruleId === RUNTIME_RULES.brokenTransition),
      ).toEqual([]);
    });

    it("ignores redirects, which are the other check's business", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [visit({ states: ["loading"] })],
          transitions: [{ from: "/invoices", to: "/login", kind: "redirect" }],
        }),
      );

      expect(
        findings.filter((f) => f.ruleId === RUNTIME_RULES.brokenTransition),
      ).toEqual([]);
    });

    it("says nothing when the source describes no destination", () => {
      // A screen with no outgoing navigation in the graph has made no promise
      // to break. Treating "no declared destination" as "must not navigate"
      // would report every client-side route change the indexer cannot see.
      const bare = graph();
      bare.edges = bare.edges.filter((edge) => edge.type !== "transitions_to");

      const findings = diffObserved(
        bare,
        run({
          attempted: ["/invoices"],
          visits: [visit({ states: ["loading"] })],
          transitions: [{ from: "/invoices", to: "/anywhere", kind: "click" }],
        }),
      );

      expect(
        findings.filter((f) => f.ruleId === RUNTIME_RULES.brokenTransition),
      ).toEqual([]);
    });
  });

  describe("console errors", () => {
    it("reports them, with a cap on the noise", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [
            visit({
              states: ["loading"],
              errors: ["a", "b", "c", "d", "e"],
            }),
          ],
        }),
      );

      const error = findings.find((f) => f.ruleId === RUNTIME_RULES.consoleError);
      expect(error?.message).toContain("5 error");
      // Five errors on one page is one finding with a sample, not five
      // findings or a wall of evidence.
      expect(error?.evidence).toHaveLength(3);
      expect(error?.severity).toBe("medium");
    });
  });

  describe("undeclared routes", () => {
    it("keeps quiet by default", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [visit({ states: ["loading"] }), visit({ route: "/surprise", requested: "/surprise", settled: "/surprise" })],
        }),
      );

      // A route the browser found and the indexer missed is usually Drumlin's
      // blind spot. Putting our own gaps on the developer's list by default is
      // how a tool loses credibility.
      expect(findings.filter((f) => f.ruleId === RUNTIME_RULES.undeclared)).toEqual([]);
    });

    it("reports them when asked", () => {
      const findings = diffObserved(
        graph(),
        run({
          attempted: ["/invoices"],
          visits: [
            visit({ states: ["loading"] }),
            visit({ route: "/surprise", requested: "/surprise", settled: "/surprise" }),
          ],
        }),
        { reportUndeclared: true },
      );

      const undeclared = findings.find((f) => f.ruleId === RUNTIME_RULES.undeclared);
      expect(undeclared?.target.route).toBe("/surprise");
      expect(undeclared?.severity).toBe("low");
      expect(undeclared?.proposal).toContain("blind spot");
    });
  });

  describe("findings", () => {
    it("marks everything as runtime evidence", () => {
      const findings = diffObserved(
        graph(),
        run({ attempted: ["/invoices", "/invoices/[id]"], visits: [] }),
      );

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        // Classification is what lets `verifyIssue` tell a static conclusion
        // from an observed one, which is the entire reason this exists.
        expect(finding.classification).toBe("runtime");
        expect(finding.evidence.some((e) => e.type === "runtime")).toBe(true);
        expect(finding.message.length).toBeGreaterThan(20);
      }
    });
  });
});
