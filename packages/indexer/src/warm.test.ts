import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GraphNode } from "@drumlin/model";
import { IndexSession, resolveApp } from "./index.js";
import { createProject } from "./project.js";
import { textWithoutComments } from "./analyze/text.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/mixed-app", import.meta.url));

/**
 * Freshness of the warm index.
 *
 * The daemon holds a `Project` in memory and re-reads changed files into it,
 * which is what makes continuous checking affordable. It also means every
 * derived value in the analysis layer has to be invalidated correctly, and
 * anything keyed on a `SourceFile` object will not be — `refreshFromFileSystemSync`
 * mutates the existing instance rather than replacing it.
 *
 * These tests exist because that went wrong in exactly that way, and the shape
 * of the failure is nasty: correct in a cold process, wrong in the daemon, and
 * the daemon is the default in an editor.
 */
describe("warm re-index", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-warm-"));
    cpSync(FIXTURE, root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function session(): IndexSession {
    return new IndexSession(resolveApp({ root }));
  }

  function actionNode(nodes: readonly GraphNode[], label: string): GraphNode {
    const node = nodes.find(
      (candidate) => candidate.type === "Action" && candidate.label === label,
    );
    expect(node, `expected an Action node labelled ${label}`).toBeDefined();
    return node!;
  }

  /** Add a confirmation at the call site of the destructive action. */
  function addConfirmation(): void {
    const page = join(root, "app/invoices/[id]/page.tsx");
    const source = readFileSync(page, "utf8");
    const fixed = source.replace(
      "<form action={deleteInvoice}>",
      `<form action={deleteInvoice} onSubmit={(e) => { if (!window.confirm("Are you sure?")) e.preventDefault(); }}>`,
    );
    expect(fixed, "fixture markup changed; update this helper").not.toBe(source);
    writeFileSync(page, fixed, "utf8");
  }

  it("sees a marker added after the session warmed", () => {
    const index = session();

    const before = actionNode(index.index().graph.nodes, "deleteInvoice");
    expect(before.properties?.["hasConfirmation"]).toBe(false);

    addConfirmation();
    index.refresh([join(root, "app/invoices/[id]/page.tsx")]);

    // The regression. This read `false` forever, because the comment-stripped
    // text was cached against the `SourceFile` object and that object is
    // mutated in place by a refresh rather than replaced.
    const after = actionNode(index.index().graph.nodes, "deleteInvoice");
    expect(after.properties?.["hasConfirmation"]).toBe(true);
  });

  it("sees a marker removed again", () => {
    const index = session();
    addConfirmation();
    index.refresh([join(root, "app/invoices/[id]/page.tsx")]);
    expect(
      actionNode(index.index().graph.nodes, "deleteInvoice").properties?.[
        "hasConfirmation"
      ],
    ).toBe(true);

    // Staleness in the other direction is the dangerous one: a reverted fix
    // that still reads as fixed means a real problem reported as solved.
    cpSync(
      join(FIXTURE, "app/invoices/[id]/page.tsx"),
      join(root, "app/invoices/[id]/page.tsx"),
    );
    index.refresh([join(root, "app/invoices/[id]/page.tsx")]);

    expect(
      actionNode(index.index().graph.nodes, "deleteInvoice").properties?.[
        "hasConfirmation"
      ],
    ).toBe(false);
  });

  it("still strips comments after a refresh", () => {
    const index = session();
    const path = join(root, "app/invoices/actions.ts");

    // The cache is there to protect the AST walk that finds comment ranges, so
    // check the invalidated path still does the stripping rather than falling
    // back to raw text — which would make every `// TODO: add a confirmation`
    // read as a confirmation.
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}\n// TODO: window.confirm before deleting\n`,
      "utf8",
    );
    index.refresh([path]);

    const source = index.index();
    expect(source.graph.nodes.length).toBeGreaterThan(0);
    expect(
      actionNode(source.graph.nodes, "deleteInvoice").properties?.[
        "hasConfirmation"
      ],
    ).toBe(false);
  });

  it("still caches when the text has not changed", () => {
    const project = createProject();
    const file = project.createSourceFile(
      "sample.ts",
      "// a comment\nexport const x = 1;\n",
    );

    // Identity, not equality. The content check must reuse the stored string
    // rather than redo the AST walk on every call, or the fix for staleness
    // would have turned a cache into a tax on the hot path.
    const first = textWithoutComments(file);
    expect(textWithoutComments(file)).toBe(first);

    // And it must let go the moment the text does change.
    file.replaceWithText("// a comment\nexport const x = 2;\n");
    expect(textWithoutComments(file)).not.toBe(first);
    expect(textWithoutComments(file)).toContain("x = 2");
    expect(textWithoutComments(file)).not.toContain("a comment");
  });
});
