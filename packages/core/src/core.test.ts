import { describe, expect, test } from "vitest";
import {
  IR_SCHEMA_VERSION,
  findingFingerprint,
  type Finding,
  type GraphDocument,
  type GraphEdge,
  type GraphNode,
  type Issue,
} from "@drumlin/model";
import {
  GraphView,
  MILESTONE_A_RULES,
  commonRoutePrefix,
  deadEnds,
  entryPoints,
  isConventionalEntryRoute,
  orphanScreens,
  reachableFrom,
  reconcile,
  runRules,
  rulesById,
} from "./index.js";

function graph(nodes: GraphNode[], edges: GraphEdge[]): GraphView {
  const document: GraphDocument = {
    schemaVersion: IR_SCHEMA_VERSION,
    layer: "actual",
    nodes,
    edges,
  };
  return new GraphView(document);
}

function screen(
  id: string,
  route: string,
  extra: Partial<GraphNode> = {},
): GraphNode {
  return { id, type: "Screen", route, ...extra };
}

function transition(
  from: string,
  to: string,
  chrome = false,
  extra: Partial<GraphEdge> = {},
): GraphEdge {
  return {
    from,
    to,
    type: "transitions_to",
    properties: { chrome },
    ...extra,
  };
}

describe("entry point resolution", () => {
  test("the root is always an entry point", () => {
    expect(isConventionalEntryRoute("/")).toBe(true);
  });

  test("auth routes are entered from outside the product", () => {
    for (const route of [
      "/login",
      "/signup",
      "/verify-request",
      "/forgot-password",
      "/auth/callback",
    ]) {
      expect(isConventionalEntryRoute(route)).toBe(true);
    }
  });

  test("a route with a token parameter arrives from a link", () => {
    // These accounted for four of five false orphans on the first real app.
    expect(isConventionalEntryRoute("/set-password/[token]")).toBe(true);
    expect(isConventionalEntryRoute("/invite/[token]")).toBe(true);
  });

  test("an ordinary screen is not an entry point", () => {
    expect(isConventionalEntryRoute("/portal/patients/[id]")).toBe(false);
    expect(isConventionalEntryRoute("/portal/dashboard")).toBe(false);
  });

  test("a locale prefix does not hide the route underneath", () => {
    // `/[locale]` is the home page of a localised site, not a parameterised
    // screen. Reading it literally made the home page an orphan.
    expect(isConventionalEntryRoute("/[locale]")).toBe(true);
    expect(isConventionalEntryRoute("/[lang]/login")).toBe(true);
    expect(isConventionalEntryRoute("/[locale]/pricing")).toBe(false);
  });

  test("development and test harness routes are entered by hand", () => {
    expect(isConventionalEntryRoute("/e2e/card-safety")).toBe(true);
    expect(isConventionalEntryRoute("/development")).toBe(true);
    expect(isConventionalEntryRoute("/storybook")).toBe(true);
  });

  test("declared entry points are honoured", () => {
    const view = graph([screen("screen.reports", "/reports")], []);
    expect(entryPoints(view)).toEqual([]);
    expect(entryPoints(view, { declared: ["/reports"] })).toEqual([
      "screen.reports",
    ]);
  });
});

describe("reachability", () => {
  const view = graph(
    [
      screen("screen.root", "/"),
      screen("screen.list", "/list"),
      screen("screen.detail", "/list/[id]"),
      screen("screen.hidden", "/hidden"),
      screen("screen.viaChrome", "/via-chrome"),
    ],
    [
      transition("screen.root", "screen.list"),
      transition("screen.list", "screen.detail"),
      transition("screen.root", "screen.viaChrome", true),
    ],
  );

  test("chrome navigation counts as a way to reach a screen", () => {
    // A sidebar link is a real way to get somewhere, even though it is not a
    // way onward from any particular screen.
    expect(reachableFrom(view, ["screen.root"]).has("screen.viaChrome")).toBe(
      true,
    );
  });

  test("an unlinked screen is unreachable", () => {
    expect(reachableFrom(view, ["screen.root"]).has("screen.hidden")).toBe(
      false,
    );
  });

  test("orphan detection reports only the unreachable screen", () => {
    expect(orphanScreens(view).map((node) => node.route)).toEqual(["/hidden"]);
  });

  test("reachability terminates on a cycle", () => {
    const cyclic = graph(
      [screen("a", "/a"), screen("b", "/b")],
      [transition("a", "b"), transition("b", "a")],
    );
    expect(reachableFrom(cyclic, ["a"]).size).toBe(2);
  });

  test("a route named elsewhere is not reported as an orphan", () => {
    // The link exists but was assembled at runtime or written in an article.
    // Reporting these made 18 of 44 orphan findings on a real app wrong.
    const view = graph(
      [
        screen("screen.root", "/"),
        screen("screen.hub", "/hub", {
          properties: { mentionedIn: ["src/guides/intro.mdx"] },
        }),
        screen("screen.gone", "/gone"),
      ],
      [],
    );
    expect(orphanScreens(view).map((node) => node.route)).toEqual(["/gone"]);
  });
});

describe("dead-end detection", () => {
  const action: GraphNode = { id: "action.submit", type: "Action" };

  test("a screen with an action and no way onward is a dead end", () => {
    const view = graph(
      [screen("screen.root", "/"), screen("screen.end", "/end"), action],
      [
        transition("screen.root", "screen.end"),
        { from: "screen.end", to: "action.submit", type: "contains" },
      ],
    );
    expect(deadEnds(view).map((entry) => entry.screen.route)).toEqual(["/end"]);
  });

  test("global navigation does not rescue a dead end", () => {
    // Otherwise no screen in any app with a nav bar could ever be a dead end.
    const view = graph(
      [screen("screen.root", "/"), screen("screen.end", "/end"), action],
      [
        transition("screen.root", "screen.end"),
        transition("screen.end", "screen.root", true),
        { from: "screen.end", to: "action.submit", type: "contains" },
      ],
    );
    expect(deadEnds(view)).toHaveLength(1);
  });

  test("a screen where nothing happens is not a dead end", () => {
    // A static leaf page the user reads and leaves is not a problem.
    const view = graph(
      [screen("screen.root", "/"), screen("screen.about", "/about")],
      [transition("screen.root", "screen.about")],
    );
    expect(deadEnds(view)).toEqual([]);
  });

  test("a screen nobody links to is not reported as a dead end", () => {
    const view = graph(
      [screen("screen.stray", "/stray"), action],
      [{ from: "screen.stray", to: "action.submit", type: "contains" }],
    );
    expect(deadEnds(view)).toEqual([]);
  });
});

describe("common route prefix", () => {
  test("finds the shared section", () => {
    expect(
      commonRoutePrefix([
        "/portal/audit",
        "/portal/metrics/weekly",
        "/portal/x",
      ]),
    ).toBe("/portal");
  });

  test("falls back to the root when nothing is shared", () => {
    expect(commonRoutePrefix(["/a", "/b"])).toBe("/");
  });

  test("handles a single route", () => {
    expect(commonRoutePrefix(["/portal/audit"])).toBe("/portal/audit");
  });
});

describe("rules on a synthetic app", () => {
  const view = graph(
    [
      screen("screen.root", "/", { context: { async: false } }),
      screen("screen.list", "/list", {
        context: { async: true },
        properties: {
          fetchesData: true,
          searchParamKeys: ["status", "page"],
          handledStates: { loading: true, error: true, empty: true },
        },
      }),
      screen("screen.detail", "/list/[id]", {
        context: { async: true },
        properties: {
          fetchesData: true,
          searchParamKeys: [],
          handledStates: { loading: false, error: false, empty: false },
        },
      }),
      {
        id: "action.delete-thing",
        type: "Action",
        context: { destructive: true },
      },
    ],
    [
      transition("screen.root", "screen.list"),
      transition("screen.list", "screen.detail"),
      transition("screen.detail", "screen.list"),
      { from: "screen.detail", to: "action.delete-thing", type: "contains" },
    ],
  );

  const result = runRules(MILESTONE_A_RULES, {
    view,
    entryPoints: entryPoints(view),
  });

  const ids = (): string[] => result.findings.map((finding) => finding.ruleId);

  test("no rule throws", () => {
    expect(result.errors).toEqual([]);
  });

  test("a screen that handles its own states is left alone", () => {
    const onList = result.findings.filter(
      (finding) => finding.target.node === "screen.list",
    );
    expect(onList.map((finding) => finding.ruleId)).not.toContain(
      "state.route.no-loading",
    );
  });

  test("a screen with neither boundary nor in-component handling is reported", () => {
    expect(ids()).toContain("state.route.no-loading");
    expect(ids()).toContain("state.route.no-error");
  });

  test("a destructive action with no confirmation is critical", () => {
    const finding = result.findings.find(
      (candidate) => candidate.ruleId === "flow.destructive.no-confirm",
    );
    expect(finding?.severity).toBe("critical");
  });

  test("returning to a filtered list without its filters is reported", () => {
    const finding = result.findings.find(
      (candidate) =>
        candidate.ruleId === "context.navigation.drops-search-params",
    );
    expect(finding?.target.to).toBe("screen.list");
    expect(finding?.message).toContain("status");
  });

  test("a static screen produces no state findings", () => {
    const onRoot = result.findings.filter(
      (finding) => finding.target.node === "screen.root",
    );
    expect(onRoot).toEqual([]);
  });

  test("every finding satisfies the output contract", () => {
    for (const finding of result.findings) {
      expect(finding.ruleId).toMatch(/^[a-z]+[a-z.-]*$/);
      expect(finding.message.length).toBeGreaterThan(20);
      expect(finding.confidence).toBeGreaterThan(0);
      expect(finding.confidence).toBeLessThanOrEqual(1);
      expect(finding.evidence.length).toBeGreaterThan(0);
      // The message must describe the product problem, not name the rule.
      expect(finding.message).not.toContain(finding.ruleId);
    }
  });

  test("findings come back ranked, most severe first", () => {
    const severities = result.findings.map((finding) => finding.severity);
    expect(severities[0]).toBe("critical");
  });

  test("rule selection filters by id", () => {
    expect(rulesById(["flow.orphan"]).map((rule) => rule.id)).toEqual([
      "flow.orphan",
    ]);
    expect(rulesById([]).length).toBe(MILESTONE_A_RULES.length);
  });
});

/**
 * How strongly a state finding claims to know what it found.
 *
 * From dogfooding a real app: its root route is an auth gate that awaits
 * `auth()`, redirects, and renders static copy. Drumlin reported it as
 * "fetches data ... the user cannot tell broken from empty" at 0.85. The gap
 * was real — the app had no error boundary anywhere — but the sentence
 * described a list screen, and a high-severity finding that misdescribes its
 * own cause sends an agent to fix the wrong thing.
 */
describe("state rules hedge on weak data evidence", () => {
  function screenWith(evidence: string[]) {
    return graph(
      [
        screen("screen.gate", "/", {
          context: { async: true },
          properties: {
            fetchesData: true,
            dataEvidence: evidence,
            prerendered: false,
            searchParamKeys: [],
            handledStates: { loading: false, error: false, empty: false },
          },
        }),
      ],
      [],
    );
  }

  function findingFor(evidence: string[], ruleId: string) {
    const view = screenWith(evidence);
    return runRules(MILESTONE_A_RULES, {
      view,
      entryPoints: entryPoints(view),
    }).findings.find((finding) => finding.ruleId === ruleId);
  }

  test("a bare await is described as a bare await", () => {
    const finding = findingFor(
      ["awaits a value during render"],
      "state.route.no-error",
    );

    expect(finding?.message).toContain("awaits a value while rendering");
    expect(finding?.message).not.toContain("fetches data");
    // Still reported, and still high: an unhandled rejection renders nothing
    // either way. Only the claim about what it found is softened.
    expect(finding?.severity).toBe("high");
    expect(finding?.confidence).toBe(0.6);
  });

  test("an explicit query is described as fetching data", () => {
    const finding = findingFor(
      ["uses useQuery() at line 12"],
      "state.route.no-error",
    );

    expect(finding?.message).toContain("fetches data");
    expect(finding?.confidence).toBe(0.85);
  });

  test("a bare await alongside a real query is not hedged", () => {
    const finding = findingFor(
      ["uses useQuery() at line 12", "awaits a value during render"],
      "state.route.no-error",
    );

    expect(finding?.message).toContain("fetches data");
    expect(finding?.confidence).toBe(0.85);
  });

  test("the loading rule hedges on the same signal", () => {
    const weak = findingFor(
      ["awaits a value during render"],
      "state.route.no-loading",
    );
    const strong = findingFor(
      ["queries prisma.user() at line 4"],
      "state.route.no-loading",
    );

    expect(weak?.message).toContain("awaits a value while rendering");
    expect(weak?.confidence).toBe(0.6);
    expect(strong?.message).toContain("fetches data");
    expect(strong?.confidence).toBe(0.85);
  });
});

describe("state rules on routes that render at build time", () => {
  // Every state finding on the first content site measured was this case: an
  // MDX route reads data during the build, so there is no request to be slow
  // and no fetch to fail.
  const view = graph(
    [
      screen("screen.root", "/"),
      screen("screen.post", "/blog/[slug]", {
        context: { async: true },
        properties: {
          fetchesData: true,
          prerendered: true,
          searchParamKeys: [],
          handledStates: { loading: false, error: false, empty: false },
        },
      }),
    ],
    [transition("screen.root", "screen.post")],
  );

  const findings = runRules(MILESTONE_A_RULES, {
    view,
    entryPoints: entryPoints(view),
  }).findings;

  test("no loading or error state is asked of a prerendered route", () => {
    const ids = findings.map((finding) => finding.ruleId);
    expect(ids).not.toContain("state.route.no-loading");
    expect(ids).not.toContain("state.route.no-error");
  });

  test("a missing record is still worth handling", () => {
    // Prerendering says nothing about a slug that was never generated.
    expect(findings.map((finding) => finding.ruleId)).toContain(
      "state.route.no-not-found",
    );
  });

  test("a locale prefix is not a record that can be missing", () => {
    const localised = graph(
      [
        screen("screen.locale.terms", "/[locale]/terms", {
          context: { async: true },
          properties: {
            fetchesData: true,
            searchParamKeys: [],
            handledStates: { loading: false, error: false, empty: false },
          },
        }),
      ],
      [],
    );
    const ids = runRules(MILESTONE_A_RULES, {
      view: localised,
      entryPoints: entryPoints(localised),
    }).findings.map((finding) => finding.ruleId);
    expect(ids).not.toContain("state.route.no-not-found");
  });
});

describe("engine deduplication", () => {
  const base: Finding = {
    ruleId: "state.route.no-error",
    scope: "screen",
    severity: "high",
    confidence: 0.85,
    classification: "deterministic",
    target: { kind: "node", node: "screen.a", route: "/portal/a" },
    evidence: [{ type: "graph", ref: "screen.a" }],
    message: "A screen fetches data but has no error state at all.",
  };

  function ruleEmitting(findings: Finding[], group?: boolean) {
    return {
      id: base.ruleId,
      scope: "screen",
      classification: "deterministic" as const,
      severity: "high" as const,
      summary: "test",
      ...(group
        ? {
            group: {
              minMembers: 3,
              message: (count: number, prefix: string) =>
                `${count} screens under ${prefix} have no error state.`,
              proposal: (_count: number, prefix: string) =>
                `Add one boundary at ${prefix}.`,
            },
          }
        : {}),
      evaluate: () => findings,
    };
  }

  const emptyView = graph([], []);

  test("the same rule on the same target reports once", () => {
    const result = runRules([ruleEmitting([base, { ...base }])], {
      view: emptyView,
      entryPoints: [],
    });
    expect(result.findings).toHaveLength(1);
    expect(result.rawCount).toBe(2);
  });

  test("findings sharing a fix collapse into one that names the section", () => {
    const cluster = ["/portal/a", "/portal/b", "/portal/c", "/portal/d"].map(
      (route, index): Finding => ({
        ...base,
        target: { kind: "node", node: `screen.${index}`, route },
      }),
    );

    const result = runRules([ruleEmitting(cluster, true)], {
      view: emptyView,
      entryPoints: [],
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.message).toContain("4 screens under /portal");
    expect(result.findings[0]!.target.route).toBe("/portal");
    // Grouping must not lose which screens were affected.
    const refs = result.findings[0]!.evidence.map((item) => item.ref);
    expect(refs).toContain("/portal/a");
    expect(refs).toContain("/portal/d");
  });

  test("a grouped finding does not repeat one criterion per member", () => {
    // Most rules phrase acceptance criteria without naming a route, so every
    // member of a cluster contributes the same sentence. Collecting them
    // verbatim produced an exported checklist with the same box on it five
    // times, which reads as a broken ticket rather than as five screens.
    const cluster = ["/portal/a", "/portal/b", "/portal/c", "/portal/d"].map(
      (route, index): Finding => ({
        ...base,
        target: { kind: "node", node: `screen.${index}`, route },
        acceptance: ["The screen explains the failure and offers a retry."],
      }),
    );

    const result = runRules([ruleEmitting(cluster, true)], {
      view: emptyView,
      entryPoints: [],
    });

    expect(result.findings[0]!.acceptance).toEqual([
      "The screen explains the failure and offers a retry.",
    ]);
  });

  test("a grouped finding keeps criteria that genuinely differ", () => {
    const cluster = ["/portal/a", "/portal/b", "/portal/c"].map(
      (route, index): Finding => ({
        ...base,
        target: { kind: "node", node: `screen.${index}`, route },
        acceptance: [`${route} explains the failure.`],
      }),
    );

    const result = runRules([ruleEmitting(cluster, true)], {
      view: emptyView,
      entryPoints: [],
    });

    expect(result.findings[0]!.acceptance).toHaveLength(3);
  });

  test("a group below the threshold stays as individual findings", () => {
    const cluster = ["/portal/a", "/portal/b"].map((route, index): Finding => ({
      ...base,
      target: { kind: "node", node: `screen.${index}`, route },
    }));
    const result = runRules([ruleEmitting(cluster, true)], {
      view: emptyView,
      entryPoints: [],
    });
    expect(result.findings).toHaveLength(2);
  });

  test("a rule that throws does not stop the run", () => {
    const exploding = {
      id: "boom",
      scope: "screen",
      classification: "deterministic" as const,
      severity: "low" as const,
      summary: "throws",
      evaluate: () => {
        throw new Error("bad rule");
      },
    };
    const result = runRules([exploding, ruleEmitting([base])], {
      view: emptyView,
      entryPoints: [],
    });
    expect(result.errors[0]?.ruleId).toBe("boom");
    expect(result.findings).toHaveLength(1);
  });

  test("an orphan explains its own dead end, so only one is reported", () => {
    const target = { kind: "node" as const, node: "screen.x", route: "/x" };
    const orphanFinding: Finding = {
      ...base,
      ruleId: "flow.orphan",
      classification: "graph",
      target,
      message: "This screen exists but nothing links to it anywhere.",
    };
    const deadEndFinding: Finding = {
      ...base,
      ruleId: "flow.dead-end",
      classification: "graph",
      target,
      message: "This screen lets the user act but offers no way onward.",
    };

    const result = runRules(
      [
        ruleEmitting([]),
        { ...ruleEmitting([orphanFinding]), id: "flow.orphan" },
        { ...ruleEmitting([deadEndFinding]), id: "flow.dead-end" },
      ],
      { view: emptyView, entryPoints: [] },
    );

    expect(result.findings.map((finding) => finding.ruleId)).toEqual([
      "flow.orphan",
    ]);
    expect(result.suppressed[0]?.reason).toContain("flow.orphan");
  });
});

describe("issue reconciliation", () => {
  const finding: Finding = {
    ruleId: "flow.destructive.no-confirm",
    scope: "action",
    severity: "critical",
    confidence: 0.85,
    classification: "deterministic",
    target: { kind: "node", node: "action.delete-user" },
    evidence: [{ type: "graph", ref: "action.delete-user" }],
    message: "Deleting a user runs with no confirmation and cannot be undone.",
  };

  function allocator(): (fingerprint: string) => string {
    const assigned = new Map<string, string>();
    let next = 0;
    return (fingerprint) => {
      const existing = assigned.get(fingerprint);
      if (existing) return existing;
      next += 1;
      const id = `UX-${String(next).padStart(4, "0")}`;
      assigned.set(fingerprint, id);
      return id;
    };
  }

  test("a new finding becomes a detected issue", () => {
    const result = reconcile({
      findings: [finding],
      existing: [],
      now: "2026-01-01T00:00:00.000Z",
      allocateId: allocator(),
    });
    expect(result.issues[0]!.status).toBe("detected");
    expect(result.counts.introduced).toBe(1);
  });

  test("re-running keeps the same issue id", () => {
    const allocate = allocator();
    const first = reconcile({
      findings: [finding],
      existing: [],
      now: "2026-01-01T00:00:00.000Z",
      allocateId: allocate,
    });
    const second = reconcile({
      findings: [finding],
      existing: first.issues,
      now: "2026-01-02T00:00:00.000Z",
      allocateId: allocate,
    });
    expect(second.issues[0]!.id).toBe(first.issues[0]!.id);
    expect(second.counts.introduced).toBe(0);
  });

  test("severity moving does not change the issue id", () => {
    const allocate = allocator();
    const first = reconcile({
      findings: [finding],
      existing: [],
      now: "2026-01-01T00:00:00.000Z",
      allocateId: allocate,
    });
    const second = reconcile({
      findings: [{ ...finding, severity: "low", confidence: 0.4 }],
      existing: first.issues,
      now: "2026-01-02T00:00:00.000Z",
      allocateId: allocate,
    });
    expect(second.issues[0]!.id).toBe(first.issues[0]!.id);
    expect(second.issues[0]!.severity).toBe("low");
  });

  test("an accepted issue stays accepted when re-detected", () => {
    // The single most important durability property: a human decision to live
    // with something must survive every future run.
    const accepted: Issue = {
      id: "UX-0001",
      fingerprint: findingFingerprint(finding),
      status: "accepted",
      severity: "critical",
      confidence: 0.85,
      classification: "deterministic",
      rule: { id: finding.ruleId },
      target: finding.target,
      evidence: finding.evidence,
      message: finding.message,
      detectedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      acceptedReason: "Internal admin tool, operators are trained.",
    };

    const result = reconcile({
      findings: [finding],
      existing: [accepted],
      now: "2026-02-01T00:00:00.000Z",
      allocateId: allocator(),
    });

    expect(result.issues[0]!.status).toBe("accepted");
    expect(result.issues[0]!.acceptedReason).toContain("operators are trained");
    expect(result.counts.accepted).toBe(1);
  });

  test("an issue nobody reports keeps its record rather than being resolved", () => {
    const existing: Issue = {
      id: "UX-0007",
      fingerprint: "some.rule|node:screen.gone",
      status: "detected",
      severity: "medium",
      confidence: 0.8,
      classification: "graph",
      rule: { id: "some.rule" },
      target: { kind: "node", node: "screen.gone" },
      evidence: [],
      message: "A screen exists but nothing links to it anywhere at all.",
      detectedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };

    const result = reconcile({
      findings: [],
      existing: [existing],
      now: "2026-02-01T00:00:00.000Z",
      allocateId: allocator(),
    });

    // Only the verifier may resolve. Absence of a finding is not verification.
    expect(result.issues[0]!.status).toBe("detected");
    expect(result.counts.noLongerDetected).toBe(1);
  });

  test("a finding returning after resolution reopens the issue", () => {
    const resolved: Issue = {
      id: "UX-0002",
      fingerprint: findingFingerprint(finding),
      status: "resolved",
      severity: "critical",
      confidence: 0.85,
      classification: "deterministic",
      rule: { id: finding.ruleId },
      target: finding.target,
      evidence: finding.evidence,
      message: finding.message,
      detectedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-05T00:00:00.000Z",
    };

    const result = reconcile({
      findings: [finding],
      existing: [resolved],
      now: "2026-02-01T00:00:00.000Z",
      allocateId: allocator(),
    });

    expect(result.issues[0]!.status).toBe("reopened");
    expect(result.issues[0]!.history?.at(-1)?.to).toBe("reopened");
  });
});
