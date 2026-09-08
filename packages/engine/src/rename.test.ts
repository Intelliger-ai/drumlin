import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRepo, repoPaths } from "@drumlin/repo";
import type { Issue } from "@drumlin/model";
import { InProcessEngine } from "./in-process.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../indexer/fixtures/mixed-app",
);

/**
 * Renaming a route must not un-accept anything.
 *
 * The end-to-end version of [[Graph Identity]], against a real Next.js app
 * rather than a hand-built graph. It is the case that made the resolver worth
 * building: node ids are derived from routes, issue fingerprints are derived
 * from node ids, and `reconcile` matches purely on fingerprint. So before the
 * resolver existed, renaming `/reports` to `/analytics` retired every `UX-`
 * number on that screen, minted fresh ones, and stranded the acceptance
 * decisions on issues that would never be reported again.
 *
 * From the developer's side that reads as "accepting findings does not work",
 * with no way to connect it to the rename that caused it.
 */
describe("renaming a route", () => {
  let root: string;
  const engine = new InProcessEngine();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-rename-"));
    cpSync(FIXTURE, root, { recursive: true });
    initRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Move `app/<from>` to `app/<to>`, fixing links so the graph still connects. */
  function renameRoute(from: string, to: string): void {
    renameSync(join(root, "app", from), join(root, "app", to));

    // The inbound links matter. A renamed screen nothing points at is orphaned
    // in the new graph, which changes its findings and is a different test.
    for (const file of ["app/page.tsx", "app/layout.tsx"]) {
      const path = join(root, file);
      const source = readFileSync(path, "utf8");
      writeFileSync(path, source.replaceAll(`/${from}`, `/${to}`), "utf8");
    }
  }

  async function check(): Promise<Issue[]> {
    const { issues } = await engine.request("check.run", {
      root,
      cache: false,
    });
    return issues;
  }

  function on(issues: readonly Issue[], node: string): Issue[] {
    return issues.filter((issue) => issue.target.node === node);
  }

  it("carries an accepted issue onto the renamed node", async () => {
    const before = await check();
    const target = on(before, "screen.reports")[0];
    expect(
      target,
      "fixture should produce a finding on /reports",
    ).toBeDefined();

    const { issue: accepted } = await engine.request("issue.accept", {
      root,
      id: target!.id,
      reason: "reports genuinely has nothing to show yet",
      attestation: [
        "interactive terminal",
        "confirmed at an interactive prompt",
      ],
    });
    expect(accepted.status).toBe("accepted");

    renameRoute("reports", "analytics");
    const after = await check();

    const moved = after.find((issue) => issue.id === accepted.id);

    // The same UX- number, now pointing at the new node, still accepted.
    expect(moved?.target.node).toBe("screen.analytics");
    expect(moved?.status).toBe("accepted");
    expect(moved?.acceptedReason).toBe(
      "reports genuinely has nothing to show yet",
    );
  });

  it("does not mint a duplicate for the renamed screen", async () => {
    const before = await check();
    const originals = on(before, "screen.reports").map((issue) => issue.id);
    expect(originals.length).toBeGreaterThan(0);

    renameRoute("reports", "analytics");
    const after = await check();

    // Every finding on the new node should carry a number from the old one.
    // A fresh id here is the bug: same problem, second ticket.
    const moved = on(after, "screen.analytics").map((issue) => issue.id);
    expect(moved.sort()).toEqual(originals.sort());
    expect(on(after, "screen.reports")).toHaveLength(0);
  });

  it("reports what it did", async () => {
    await check();
    renameRoute("reports", "analytics");

    const result = await engine.request("check.run", { root, cache: false });

    // Silent retargeting would be worse than none. Somebody debugging a lost
    // number needs to see what the resolver decided and why.
    const renamed = result.renames?.renamed.find(
      (entry) => entry.from === "screen.reports",
    );
    expect(renamed?.to).toBe("screen.analytics");
    expect(renamed?.because.length).toBeGreaterThan(0);
    expect(result.renames?.retargeted.length).toBeGreaterThan(0);
  });

  it("writes a baseline that is committed, not cached", async () => {
    await check();

    const paths = repoPaths(root);
    const baseline = join(paths.dir, "graph", "identity.json");
    const snapshot = JSON.parse(readFileSync(baseline, "utf8")) as {
      nodes: Array<{ id: string }>;
    };

    expect(snapshot.nodes.length).toBeGreaterThan(0);
    // `.drumlin/.gitignore` excludes `cache/` as disposable. Losing this file
    // loses identity, which is data loss rather than a cache miss, so it must
    // not live there.
    expect(readFileSync(join(paths.dir, ".gitignore"), "utf8")).not.toContain(
      "graph",
    );
    expect(baseline.includes("/cache/")).toBe(false);
  });

  it("loses nothing when a route did not move", async () => {
    const before = await check();

    // Adding an unrelated screen must not disturb anything, and must not
    // report a rename just because the graph changed shape.
    mkdirSync(join(root, "app", "audit"), { recursive: true });
    writeFileSync(
      join(root, "app", "audit", "page.tsx"),
      "export default function Audit() {\n  return <main>Audit</main>;\n}\n",
      "utf8",
    );

    const result = await engine.request("check.run", { root, cache: false });
    const ids = new Map(before.map((issue) => [issue.fingerprint, issue.id]));

    for (const issue of result.issues) {
      const previous = ids.get(issue.fingerprint);
      if (previous) expect(issue.id).toBe(previous);
    }
    expect(result.renames?.renamed ?? []).toHaveLength(0);
  });

  it("survives the baseline being deleted, at the cost of the numbers", async () => {
    const before = await check();
    const target = on(before, "screen.reports")[0]!;

    // The recoverable failure. Without a baseline the resolver cannot tell a
    // rename from a delete, so ids are lost — which is why the file is
    // committed rather than cached, and why losing it must not crash.
    rmSync(join(repoPaths(root).dir, "graph"), {
      recursive: true,
      force: true,
    });
    renameRoute("reports", "analytics");

    const after = await check();

    expect(after.find((issue) => issue.id === target.id)?.target.node).toBe(
      "screen.reports",
    );
    expect(on(after, "screen.analytics").length).toBeGreaterThan(0);
  });
});
