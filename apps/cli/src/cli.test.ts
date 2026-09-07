import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRepo, repoPaths } from "@drumlin/repo";
import { InProcessEngine } from "@drumlin/engine";
import type { Finding } from "@drumlin/model";
import { parseArgs } from "./args.js";
import { renderFindings } from "./format/findings.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/indexer/fixtures/mixed-app",
);

/**
 * End-to-end tests over the engine.
 *
 * Run on a copy in a temp directory, because the behaviour under test includes
 * what does and does not get written to disk, and a test that writes into the
 * fixture would both pollute it and pass for the wrong reason on the next run.
 */
describe("engine over the fixture app", () => {
  let root: string;
  const engine = new InProcessEngine();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-cli-"));
    cpSync(FIXTURE, root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports findings without writing anything before init", async () => {
    const result = await engine.request("check.run", { root, app: root });

    expect(result.findings.length).toBeGreaterThan(8);
    expect(result.persisted).toBe(false);
    expect(existsSync(repoPaths(root).dir)).toBe(false);
  });

  it("keeps issue IDs stable across reruns once initialised", async () => {
    initRepo(root);

    const first = await engine.request("check.run", { root, app: root });
    expect(first.persisted).toBe(true);
    expect(first.counts.introduced).toBe(first.counts.total);

    const second = await engine.request("check.run", { root, app: root });
    expect(second.counts.introduced).toBe(0);
    expect(idsByFingerprint(second)).toEqual(idsByFingerprint(first));
  });

  it("preserves a human acceptance decision through a rerun", async () => {
    initRepo(root);
    const first = await engine.request("check.run", { root, app: root });

    const target = first.issues[0]!;
    const file = join(repoPaths(root).issuesDir, `${target.id}.json`);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      file,
      JSON.stringify({ ...stored, status: "accepted" }, null, 2),
      "utf8",
    );

    const second = await engine.request("check.run", { root, app: root });
    const reread = second.issues.find((issue) => issue.id === target.id);

    expect(reread?.status).toBe("accepted");
    expect(second.counts.accepted).toBe(1);
  });

  it("respects disabled rules from config", async () => {
    initRepo(root);
    writeFileSync(
      repoPaths(root).configFile,
      "rules:\n  disabled:\n    - state.route.no-error\n",
      "utf8",
    );

    const result = await engine.request("check.run", { root, app: root });
    expect(
      result.findings.some(
        (finding) => finding.ruleId === "state.route.no-error",
      ),
    ).toBe(false);
  });

  it("treats a declared entry point as reachable", async () => {
    initRepo(root);

    const before = await engine.request("check.run", { root, app: root });
    expect(orphanRoutes(before.findings)).toContain("/reports");

    writeFileSync(
      repoPaths(root).configFile,
      "entryPoints:\n  - /reports\n",
      "utf8",
    );

    const after = await engine.request("check.run", { root, app: root });
    expect(orphanRoutes(after.findings)).not.toContain("/reports");
  });

  it("reports no role model rather than guessing one", async () => {
    const result = await engine.request("context.infer", { root, app: root });

    expect(result.beliefs).toEqual([]);
    expect(result.written).toBeUndefined();
  });
});

/**
 * An empty report has two very different causes, and saying the wrong one
 * wastes the reader's time. Found by running `check --severity high` on an app
 * whose six findings were all medium: the output credited deduplication for
 * six findings and then suggested the rules were too narrow.
 */
describe("an empty report explains itself", () => {
  const finding: Finding = {
    ruleId: "state.route.no-loading",
    scope: "screen",
    severity: "medium",
    confidence: 0.85,
    classification: "deterministic",
    target: { kind: "node", node: "screen.a", route: "/a" },
    evidence: [{ type: "graph", ref: "screen.a" }],
    message: "A screen fetches data with no loading state.",
  };

  it("blames the rules only when the run really found nothing", () => {
    const text = renderFindings([], { total: 0, accepted: 0 });

    expect(text).toContain("No findings");
    expect(text).toContain("the rules are too narrow");
  });

  it("blames the severity floor when the floor did the filtering", () => {
    const text = renderFindings([], {
      total: 6,
      severity: "high",
      accepted: 0,
    });

    expect(text).toContain("Nothing at high or above");
    expect(text).toContain("6 finding(s) are below it");
    expect(text).toContain("--severity");
    expect(text).not.toContain("the rules are too narrow");
  });

  it("names acceptance when that is what hid them", () => {
    const text = renderFindings([], { total: 2, accepted: 2 });

    expect(text).toContain("2 of them are accepted deviations");
    expect(text).toContain("--accepted");
  });

  it("does not split the count between filters that can overlap", () => {
    // An accepted issue can also be below the floor, so the accepted count is
    // reported as a subset rather than as a second bucket.
    const text = renderFindings([], {
      total: 7,
      severity: "critical",
      accepted: 1,
    });

    expect(text).toContain("7 finding(s) are below it");
    expect(text).toContain("1 of them is an accepted deviation");
  });

  it("still renders findings that pass the floor", () => {
    const text = renderFindings([{ finding }], {
      total: 1,
      accepted: 0,
    });

    expect(text).toContain("A screen fetches data with no loading state.");
    expect(text).not.toContain("filtered out");
  });
});

describe("argument parsing", () => {
  it("reads --no-cache as cache false", () => {
    const args = parseArgs(["check", "--no-cache"]);
    expect(args.command).toBe("check");
    expect(args.flags.get("cache")).toBe(false);
  });

  it("reads --format json and --app with a value", () => {
    const args = parseArgs(["check", "--format", "json", "--app=/tmp/x"]);
    expect(args.flags.get("format")).toBe("json");
    expect(args.flags.get("app")).toBe("/tmp/x");
  });
});

function idsByFingerprint(result: {
  issues: Array<{ id: string; fingerprint: string }>;
}): Record<string, string> {
  return Object.fromEntries(
    result.issues.map((issue) => [issue.fingerprint, issue.id]),
  );
}

function orphanRoutes(
  findings: readonly { ruleId: string; target: { route?: string } }[],
): string[] {
  return findings
    .filter((finding) => finding.ruleId === "flow.orphan")
    .map((finding) => finding.target.route ?? "");
}
