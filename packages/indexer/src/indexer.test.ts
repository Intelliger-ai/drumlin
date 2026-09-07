import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SourceFile } from "ts-morph";
import { beforeAll, describe, expect, test } from "vitest";
import { parseGraphDocument, type GraphDocument, type GraphNode } from "@drumlin/model";
import { findActions } from "./analyze/actions.js";
import { findUnboundedSelects } from "./analyze/components.js";
import { analyzeData } from "./analyze/data.js";
import { findMarkdownLinks, findRouteMentions } from "./analyze/mentions.js";
import { compareToGolden } from "./golden.js";
import { indexApp, type IndexResult } from "./index.js";
import { describeApp, isIgnoredPath } from "./discover.js";
import { createProject } from "./project.js";
import { createImportResolver } from "./resolve.js";
import { matchRoute, toRoutePattern, DYNAMIC } from "./routes.js";

const fixtureRoot = fileURLToPath(
  new URL("../fixtures/mixed-app", import.meta.url),
);
const goldenPath = fileURLToPath(
  new URL("../fixtures/mixed-app.golden.json", import.meta.url),
);

let result: IndexResult;

beforeAll(() => {
  result = indexApp({
    // The fixture has no next.config on purpose, so the app is described
    // directly rather than discovered.
    root: fixtureRoot,
    app: { root: fixtureRoot, router: "mixed", ...routerDirs() },
  });
});

function routerDirs() {
  return {
    appDir: `${fixtureRoot}/app`,
    pagesDir: `${fixtureRoot}/pages`,
  };
}

function node(id: string): GraphNode {
  const found = result.graph.nodes.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no node ${id} in graph`);
  return found;
}

function hasEdge(from: string, type: string, to: string): boolean {
  return result.graph.edges.some(
    (edge) => edge.from === from && edge.type === type && edge.to === to,
  );
}

describe("discovery", () => {
  test("build output and vendored trees are never walked", () => {
    // .next/server/pages looks exactly like a Pages Router tree, which would
    // otherwise double every route in the product.
    expect(isIgnoredPath("/repo/.next/server/pages/index.js")).toBe(true);
    expect(isIgnoredPath("/repo/node_modules/next/link.js")).toBe(true);
    expect(isIgnoredPath("/repo/.claude/worktrees/copy/app/page.tsx")).toBe(true);
    expect(isIgnoredPath("/repo/src/app/invoices/page.tsx")).toBe(false);
  });

  test("describeApp reports a mixed router when both directories exist", () => {
    const app = describeApp(fixtureRoot);
    expect(app?.router).toBe("mixed");
  });
});

describe("route matching", () => {
  const patterns = ["/invoices", "/invoices/new", "/invoices/[id]", "/docs/[...slug]"].map(
    toRoutePattern,
  );

  test("a literal segment beats a dynamic one", () => {
    expect(matchRoute("/invoices/new", patterns)?.route).toBe("/invoices/new");
  });

  test("an interpolated segment resolves to the dynamic route", () => {
    expect(matchRoute(`/invoices/${DYNAMIC}`, patterns)?.route).toBe(
      "/invoices/[id]",
    );
  });

  test("a query string does not affect matching", () => {
    expect(matchRoute("/invoices?status=open", patterns)?.route).toBe(
      "/invoices",
    );
  });

  test("catch-all absorbs remaining segments", () => {
    expect(matchRoute("/docs/a/b/c", patterns)?.route).toBe("/docs/[...slug]");
  });

  test("an unknown route matches nothing", () => {
    expect(matchRoute("/nope", patterns)).toBeUndefined();
  });
});

describe("extraction against the golden document", () => {
  test("the extracted graph contains everything the golden asserts", () => {
    const expected: GraphDocument = parseGraphDocument(
      JSON.parse(readFileSync(goldenPath, "utf8")),
    );
    const mismatches = compareToGolden(result.graph, expected);
    expect(
      mismatches.map((mismatch) => `${mismatch.kind}: ${mismatch.detail}`),
    ).toEqual([]);
  });

  test("the graph is structurally valid", () => {
    expect(() => parseGraphDocument(result.graph)).not.toThrow();
  });

  test("every href resolved to a real route", () => {
    expect(result.brokenLinks).toEqual([]);
  });
});

describe("screens", () => {
  test("both routers produce Screen nodes in one graph", () => {
    expect(node("screen.invoices").router).toBe("app");
    expect(node("screen.legacy.billing").router).toBe("pages");
  });

  test("data fetching is detected where it happens", () => {
    expect(node("screen.invoices").context?.async).toBe(true);
    expect(node("screen.reports").context?.async).toBe(true);
    expect(node("screen.legacy.billing").context?.async).toBe(true);
  });

  test("a static screen is not marked as fetching", () => {
    // This is the gate that stops the state rules firing on every route.
    expect(node("screen.root").context?.async).toBe(false);
    expect(node("screen.settings").context?.async).toBe(false);
  });

  test("search param keys are captured from the prop type", () => {
    expect(node("screen.invoices").properties?.["searchParamKeys"]).toEqual([
      "page",
      "region",
      "status",
    ]);
  });
});

describe("states", () => {
  test("convention files become State nodes attached to their screen", () => {
    expect(hasEdge("screen.invoices.id", "contains", "state.invoices.id.loading")).toBe(true);
    expect(hasEdge("screen.invoices.id", "contains", "state.invoices.id.error")).toBe(true);
  });

  test("a screen with no boundary in its chain gets no state edge", () => {
    const states = result.graph.edges.filter(
      (edge) => edge.from === "screen.invoices" && edge.type === "contains",
    );
    expect(states.some((edge) => edge.to.endsWith(".loading"))).toBe(false);
    expect(states.some((edge) => edge.to.endsWith(".error"))).toBe(false);
  });
});

describe("actions", () => {
  test("server actions become Action nodes", () => {
    expect(node("action.approve-invoice").type).toBe("Action");
    expect(node("action.approve-invoice").properties?.["serverAction"]).toBe(true);
  });

  test("a delete is marked destructive and irreversible", () => {
    const action = node("action.delete-invoice");
    expect(action.context?.destructive).toBe(true);
    expect(action.context?.reversible).toBe(false);
  });

  test("an approve is not marked destructive", () => {
    expect(node("action.approve-invoice").context?.destructive).toBe(false);
  });

  test("the screen that invokes an action is linked to it", () => {
    expect(hasEdge("screen.invoices.id", "contains", "action.approve-invoice")).toBe(true);
  });
});

describe("transitions", () => {
  test("layout navigation is marked as chrome", () => {
    const edge = result.graph.edges.find(
      (candidate) =>
        candidate.from === "screen.settings" &&
        candidate.to === "screen.invoices",
    );
    // Reachable via the global nav, but only as chrome — otherwise no screen in
    // an app with a nav bar could ever be a dead end.
    expect(edge?.properties?.["chrome"]).toBe(true);
  });

  test("in-content links are not chrome", () => {
    const edge = result.graph.edges.find(
      (candidate) =>
        candidate.from === "screen.invoices" &&
        candidate.to === "screen.invoices.id",
    );
    expect(edge?.properties?.["chrome"]).toBe(false);
  });

  test("a link that drops filters carries no preserved keys", () => {
    const edge = result.graph.edges.find(
      (candidate) =>
        candidate.from === "screen.invoices" &&
        candidate.to === "screen.invoices.id",
    );
    expect(edge?.preserve ?? []).toEqual([]);
    expect(edge?.properties?.["forwardsSearchParams"]).toBe(false);
  });
});

describe("components", () => {
  test("a local reimplementation of a primitive is flagged on the node", () => {
    const duplicate = result.graph.nodes.find(
      (candidate) =>
        candidate.type === "Component" && candidate.label === "PrimaryButton",
    );
    expect(duplicate?.properties?.["duplicatesPrimitive"]).toBe("Button");
  });

  test("the primitive itself is not flagged", () => {
    const primitive = result.graph.nodes.find(
      (candidate) =>
        candidate.type === "Component" &&
        candidate.label === "Button" &&
        candidate.properties?.["designSystem"] === true,
    );
    expect(primitive?.properties?.["duplicatesPrimitive"]).toBeUndefined();
  });

  test("a select bound to a fetched collection is recorded", () => {
    const selects = node("screen.invoices").properties?.["unboundedSelects"];
    expect(Array.isArray(selects)).toBe(true);
    expect(selects).toHaveLength(1);
  });
});

/**
 * Analyzer regressions.
 *
 * Each case here was a false positive or a miss on a real app. They are written
 * against in-memory sources rather than the fixture app, so the fixture stays a
 * description of the rule set rather than a scrapbook of past bugs.
 */
describe("analyzer regressions", () => {
  const project = createProject();
  let counter = 0;
  const parse = (code: string): SourceFile =>
    project.createSourceFile(`/tmp/probe-${(counter += 1)}.tsx`, code);

  test("a statically generated route is not treated as request-time", () => {
    const source = parse(`
      export async function generateStaticParams() {
        return getSlugs().map((slug) => ({ slug }));
      }
      export default async function Page({ params }) {
        const post = await getPost(params.slug);
        return <article>{post.title}</article>;
      }
    `);
    const profile = analyzeData(source);
    expect(profile.fetchesData).toBe(true);
    expect(profile.prerendered).toBe(true);
  });

  test("force-dynamic overrides static generation", () => {
    const source = parse(`
      export const dynamic = 'force-dynamic';
      export async function generateStaticParams() { return []; }
      export default async function Page() {
        const rows = await fetch('/api/rows');
        return <ul>{rows}</ul>;
      }
    `);
    expect(analyzeData(source).prerendered).toBe(false);
  });

  test("a form field read is not mistaken for a search param", () => {
    const source = parse(`
      export default function Form() {
        async function submit(formData: FormData) {
          await fetch('/api/login', {
            method: 'POST',
            body: JSON.stringify({ email: formData.get('email') }),
          });
        }
        return <form action={submit} />;
      }
    `);
    expect(analyzeData(source).searchParamKeys).toEqual([]);
  });

  test("a search param read inside a component body is found", () => {
    const source = parse(`
      export default function List() {
        const params = useSearchParams();
        return <span>{params.get('status')}</span>;
      }
    `);
    expect(analyzeData(source).searchParamKeys).toEqual(["status"]);
  });

  test("a select over a prop is not called unbounded", () => {
    // A tab strip of code languages and a list of blog categories both looked
    // identical to a ten-thousand-row select before this gate existed.
    const source = parse(`
      export function Picker({ items }: { items: string[] }) {
        return (
          <Select>
            {items.map((item) => <SelectItem key={item}>{item}</SelectItem>)}
          </Select>
        );
      }
    `);
    expect(findUnboundedSelects(source)).toEqual([]);
  });

  test("a select over a fetched collection is still reported", () => {
    const source = parse(`
      export default async function Page() {
        const vendors = await fetch('/api/vendors').then((r) => r.json());
        return (
          <Select>
            {vendors.map((v) => <SelectItem key={v.id}>{v.name}</SelectItem>)}
          </Select>
        );
      }
    `);
    expect(findUnboundedSelects(source)).toHaveLength(1);
  });

  test("a text filter over the same data counts as the fix", () => {
    const source = parse(`
      export default async function Page() {
        const rows = await load();
        const [query, setQuery] = useState('');
        return (
          <Select>
            {rows.map((r) => <SelectItem key={r.id}>{r.name}</SelectItem>)}
          </Select>
        );
      }
    `);
    expect(findUnboundedSelects(source)).toEqual([]);
  });

  test("a submit handler declared inside a component is a mutation", () => {
    // Where client-side mutations actually live; reading only the top level
    // found none of the five on the first app measured.
    const source = parse(`
      export function RequestAccessForm() {
        async function handleSubmit(event) {
          await fetch('/api/request-access', { method: 'POST' });
        }
        return <form onSubmit={handleSubmit} />;
      }
    `);
    const actions = findActions(source, "components/form.tsx");
    expect(actions.map((action) => action.name)).toContain("handleSubmit");
  });

  test("an async loader that only reads is not a mutation", () => {
    const source = parse(`
      export default async function Page() {
        async function load() {
          return fetch('/api/rows', { method: 'GET' });
        }
        return <div>{await load()}</div>;
      }
    `);
    expect(findActions(source, "app/page.tsx")).toEqual([]);
  });

  test("markdown link targets are extracted", () => {
    const links = findMarkdownLinks(
      "See the [hub](/agentic-commerce/) and [terms](/terms?x=1#top).",
    );
    expect(links).toEqual(["/agentic-commerce", "/terms"]);
  });

  test("a template head is recorded as a partial route mention", () => {
    const source = parse(
      "const to = (id: string) => `/users/${id}`; const list = '/users';",
    );
    const mentions = findRouteMentions(source);
    expect(mentions).toEqual(
      expect.arrayContaining([
        { value: "/users/", partial: true },
        { value: "/users", partial: false },
      ]),
    );
  });
});

describe("import resolution", () => {
  test("an aliased default import resolves to its file", () => {
    // The layout imports `@/components/layout/navbar` as a default export, so
    // there is no exported name to match on — only the path.
    const resolve = createImportResolver("/app", [
      "/app/src/components/layout/navbar.tsx",
      "/app/src/app/layout.tsx",
    ]);
    expect(
      resolve("/app/src/app/layout.tsx", "@/components/layout/navbar"),
    ).toBe("/app/src/components/layout/navbar.tsx");
  });

  test("a relative import resolves through an index file", () => {
    const resolve = createImportResolver("/app", [
      "/app/src/components/mega-menu/index.tsx",
    ]);
    expect(
      resolve("/app/src/components/navbar.tsx", "./mega-menu"),
    ).toBe("/app/src/components/mega-menu/index.tsx");
  });

  test("a package import resolves to nothing local", () => {
    const resolve = createImportResolver("/app", ["/app/src/a.tsx"]);
    expect(resolve("/app/src/a.tsx", "next/link")).toBeUndefined();
  });
});

describe("determinism", () => {
  test("indexing twice produces an identical graph", () => {
    const again = indexApp({
      root: fixtureRoot,
      app: { root: fixtureRoot, router: "mixed", ...routerDirs() },
    });
    // generatedAt is the only field allowed to differ between runs.
    expect({ ...again.graph, generatedAt: "" }).toEqual({
      ...result.graph,
      generatedAt: "",
    });
  });
});
