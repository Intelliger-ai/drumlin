import { describe, expect, it } from "vitest";
import { parseGraphDocument } from "@drumlin/model";
import type { GraphDocument } from "@drumlin/model";
import type { PageProbe, ProbeResult } from "./page.js";
import { concretize, walkGraph } from "./walk.js";

/**
 * The walk, driven by a scripted page.
 *
 * No browser here, and that is the point of `PageProbe` existing. The
 * judgement in the harness is which routes to open, what to click, and when to
 * stop — and every one of those decisions is worth a test, which would be
 * impractical if each ran a real Chromium.
 */

const BASE = "http://localhost:3000";

function graph(): GraphDocument {
  return parseGraphDocument({
    schemaVersion: 1,
    layer: "expected",
    nodes: [
      { id: "screen.root", type: "Screen", route: "/", label: "/" },
      {
        id: "screen.invoices",
        type: "Screen",
        route: "/invoices",
        label: "/invoices",
      },
      {
        id: "screen.invoices.$id",
        type: "Screen",
        route: "/invoices/[id]",
        label: "/invoices/[id]",
      },
    ],
    edges: [
      { from: "screen.root", to: "screen.invoices", type: "transitions_to" },
    ],
  });
}

/** A page that answers from a script, and records what it was asked. */
class ScriptedPage implements PageProbe {
  readonly opened: string[] = [];
  readonly activated: string[] = [];

  constructor(
    private readonly pages: Record<string, Partial<ProbeResult>> = {},
    private readonly onActivate: Record<string, Partial<ProbeResult>> = {},
  ) {}

  async open(url: string): Promise<ProbeResult> {
    this.opened.push(url);
    const path = url.slice(BASE.length) || "/";
    const scripted = this.pages[path];
    if (scripted instanceof Error) throw scripted;
    return { url, states: [], controls: [], errors: [], ...scripted };
  }

  async activate(name: string): Promise<ProbeResult> {
    this.activated.push(name);
    const scripted = this.onActivate[name];
    return {
      url: `${BASE}/`,
      states: [],
      controls: [],
      errors: [],
      ...scripted,
    };
  }
}

describe("walkGraph", () => {
  it("opens every static route and records what it attempted", async () => {
    const page = new ScriptedPage();
    const observed = await walkGraph(graph(), page, { baseUrl: BASE });

    expect(observed.attempted).toEqual(["/", "/invoices"]);
    expect(observed.visits.map((visit) => visit.route)).toEqual([
      "/",
      "/invoices",
    ]);
  });

  it("leaves a dynamic route alone when it has no value for the segment", async () => {
    const page = new ScriptedPage();
    const observed = await walkGraph(graph(), page, { baseUrl: BASE });

    // Visiting `/invoices/[id]` literally would 404, and `diffObserved` would
    // report a real screen as unreachable. Not attempting it is what makes the
    // diff stay silent instead of lying.
    expect(observed.attempted).not.toContain("/invoices/[id]");
    expect(page.opened.every((url) => !url.includes("["))).toBe(true);
  });

  it("visits a dynamic route once given a value", async () => {
    const page = new ScriptedPage();
    const observed = await walkGraph(graph(), page, {
      baseUrl: BASE,
      params: { id: "42" },
    });

    expect(observed.attempted).toContain("/invoices/[id]");
    expect(page.opened).toContain(`${BASE}/invoices/42`);
    // Recorded under the pattern, not the concrete URL, so the diff can match
    // it against the graph node.
    const visit = observed.visits.find(
      (entry) => entry.route === "/invoices/[id]",
    );
    expect(visit?.requested).toBe("/invoices/42");
  });

  it("visits shallow routes first", async () => {
    const deep = parseGraphDocument({
      schemaVersion: 1,
      layer: "expected",
      nodes: [
        { id: "a", type: "Screen", route: "/a/b/c", label: "/a/b/c" },
        { id: "b", type: "Screen", route: "/", label: "/" },
        { id: "c", type: "Screen", route: "/a", label: "/a" },
      ],
      edges: [],
    });

    const observed = await walkGraph(deep, new ScriptedPage(), {
      baseUrl: BASE,
    });

    // Matters only when `maxVisits` cuts the walk short, which is exactly when
    // you want the pages nearest the entry point rather than an arbitrary set.
    expect(observed.attempted).toEqual(["/", "/a", "/a/b/c"]);
  });

  it("records where the browser actually landed", async () => {
    const page = new ScriptedPage({
      "/invoices": { url: `${BASE}/login`, status: 200 },
    });

    const observed = await walkGraph(graph(), page, { baseUrl: BASE });
    const visit = observed.visits.find((entry) => entry.route === "/invoices");

    expect(visit?.requested).toBe("/invoices");
    expect(visit?.settled).toBe("/login");
  });

  it("keeps walking when a page throws", async () => {
    const page = new ScriptedPage({
      "/": new Error("net::ERR_CONNECTION_REFUSED") as never,
    });

    const observed = await walkGraph(graph(), page, { baseUrl: BASE });

    // One broken page is a finding about that page, not a reason to abandon
    // the run and report nothing about the rest of the app.
    expect(observed.visits).toHaveLength(2);
    expect(observed.visits[0]?.errors[0]).toContain("ERR_CONNECTION_REFUSED");
    expect(observed.attempted).toContain("/invoices");
  });

  it("stops at maxVisits and says so", async () => {
    const observed = await walkGraph(graph(), new ScriptedPage(), {
      baseUrl: BASE,
      maxVisits: 1,
    });

    expect(observed.visits).toHaveLength(1);
    // The incompleteness has to be recorded, or the diff will treat the routes
    // it never reached as absent rather than unchecked.
    expect(observed.incomplete).toContain("stopped after 1 pages");
  });

  it("excludes routes it was told to leave alone", async () => {
    const observed = await walkGraph(graph(), new ScriptedPage(), {
      baseUrl: BASE,
      exclude: ["/invoices"],
    });

    expect(observed.attempted).toEqual(["/"]);
  });

  describe("controls", () => {
    const withButton = {
      "/": {
        controls: [{ role: "button", name: "Refresh" }],
      },
    };

    it("does not click anything unless asked", async () => {
      const page = new ScriptedPage(withButton);
      await walkGraph(graph(), page, { baseUrl: BASE });

      // Default-off because clicking buttons in an app you do not own is how a
      // harness sends an email.
      expect(page.activated).toEqual([]);
    });

    it("follows a control and records where it went", async () => {
      const page = new ScriptedPage(withButton, {
        Refresh: { url: `${BASE}/invoices` },
      });

      const observed = await walkGraph(graph(), page, {
        baseUrl: BASE,
        followControls: true,
      });

      expect(page.activated).toContain("Refresh");
      expect(observed.transitions).toContainEqual({
        from: "/",
        to: "/invoices",
        kind: "click",
        via: "Refresh",
      });
    });

    it("refuses to click anything that sounds destructive", async () => {
      const page = new ScriptedPage({
        "/": {
          controls: [
            { role: "button", name: "Delete invoice" },
            { role: "button", name: "Send reminder" },
            { role: "button", name: "Sign out" },
            { role: "button", name: "Refresh" },
          ],
        },
      });

      await walkGraph(graph(), page, { baseUrl: BASE, followControls: true });

      // Skipping a safe button costs one unexercised transition. Pressing an
      // unsafe one costs somebody's data, so the default list errs wide.
      expect(page.activated).toEqual(["Refresh"]);
    });

    it("skips disabled controls", async () => {
      const page = new ScriptedPage({
        "/": { controls: [{ role: "button", name: "Save", disabled: true }] },
      });

      await walkGraph(graph(), page, { baseUrl: BASE, followControls: true });
      expect(page.activated).toEqual([]);
    });

    it("reads an href instead of spending a page load on it", async () => {
      const page = new ScriptedPage({
        "/": {
          controls: [{ role: "link", name: "Invoices", href: "/invoices" }],
        },
      });

      const observed = await walkGraph(graph(), page, {
        baseUrl: BASE,
        followControls: true,
      });

      expect(page.activated).toEqual([]);
      expect(observed.transitions).toContainEqual({
        from: "/",
        to: "/invoices",
        kind: "click",
        via: "Invoices",
      });
    });

    it("returns to the page under test between clicks", async () => {
      const page = new ScriptedPage(
        {
          "/": {
            controls: [
              { role: "button", name: "One" },
              { role: "button", name: "Two" },
            ],
          },
        },
        { One: { url: `${BASE}/invoices` }, Two: { url: `${BASE}/invoices` } },
      );

      const observed = await walkGraph(graph(), page, {
        baseUrl: BASE,
        followControls: true,
      });

      // Without the return, "Two" is clicked on whatever "One" navigated to,
      // and every transition after the first is attributed to the wrong screen.
      expect(page.opened.filter((url) => url === `${BASE}/`)).toHaveLength(3);
      for (const transition of observed.transitions) {
        expect(transition.from).toBe("/");
      }
    });

    it("does not record a click that stayed put", async () => {
      const page = new ScriptedPage(
        { "/": { controls: [{ role: "button", name: "Refresh" }] } },
        { Refresh: { url: `${BASE}/` } },
      );

      const observed = await walkGraph(graph(), page, {
        baseUrl: BASE,
        followControls: true,
      });

      // A button that re-renders in place is not a transition, and recording
      // it as `/ -> /` would have the diff comparing it against the routes the
      // screen navigates to.
      expect(observed.transitions).toEqual([]);
    });
  });
});

describe("concretize", () => {
  it("leaves a static route alone", () => {
    expect(concretize("/invoices", {})).toBe("/invoices");
  });

  it("fills a dynamic segment", () => {
    expect(concretize("/invoices/[id]", { id: "7" })).toBe("/invoices/7");
  });

  it("fills a catch-all segment", () => {
    expect(concretize("/docs/[...slug]", { slug: "a/b" })).toBe("/docs/a/b");
  });

  it("gives up when a segment has no value", () => {
    // Deliberately `undefined` rather than a guess. A placeholder id would
    // visit a page that does not exist and report the screen as broken.
    expect(concretize("/invoices/[id]", {})).toBeUndefined();
  });

  it("keeps the root a single slash", () => {
    expect(concretize("/", {})).toBe("/");
  });
});
