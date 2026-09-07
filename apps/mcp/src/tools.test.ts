import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRepo } from "@drumlin/repo";
import { AGENT_READABLE_METHODS, InProcessEngine } from "@drumlin/engine";
import { TOOLS, TOOL_NAMES, type ToolContext, type ToolName } from "./tools.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../packages/indexer/fixtures/mixed-app",
);

/**
 * What the tools actually return.
 *
 * The surface test next door asserts the shape of the contract; this asserts
 * the substance. Output is prose an agent has to act on, so the failure mode
 * worth catching is a tool that answers without saying anything — "0 screens",
 * "unknown", an empty section — which reads as a healthy app rather than as a
 * broken tool.
 */
describe("the MCP tools against a real workspace", () => {
  let root: string;
  let context: ToolContext;

  const call = (name: ToolName, input: Record<string, unknown> = {}) => {
    const tool = TOOLS.find((candidate) => candidate.name === name)!;
    return tool.run(context, input);
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "drumlin-mcp-"));
    cpSync(FIXTURE, root, { recursive: true });
    initRepo(root);

    const engine = new InProcessEngine();
    context = { engine, root, app: root };
    await engine.request("check.run", { root, app: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("summarises the project with real counts", async () => {
    const text = await call("drumlin_project_summary");

    expect(text).toMatch(/\d+ screens/);
    expect(text).not.toMatch(/^0 screens/m);
    expect(text).toContain("router");
  });

  /**
   * Absence stated as absence. "No confirmed role model" is a fact the agent
   * can act on; silently omitting the line invites it to assume one.
   */
  it("says outright that there is no confirmed role model", async () => {
    const text = await call("drumlin_project_summary");
    expect(text).toContain("No confirmed role model");
  });

  it("describes a flow by route", async () => {
    const text = await call("drumlin_get_flow", { route: "/" });

    expect(text).toContain("Reached from");
    expect(text).toContain("Leads to");
    expect(text).toContain("States:");
    expect(text).not.toContain("file: unknown");
  });

  it("accepts a concrete URL for a dynamic route", async () => {
    // An agent reads `/invoices/42` off a screen and passes it through; making
    // it translate to `/invoices/[id]` first is a step it will get wrong.
    const dynamic = await call("drumlin_get_flow", { route: "/invoices/[id]" });
    const concrete = await call("drumlin_get_flow", { route: "/invoices/42" });

    expect(concrete.split("\n")[0]).toBe(dynamic.split("\n")[0]);
  });

  it("explains an unknown route rather than returning nothing", async () => {
    await expect(
      call("drumlin_get_flow", { route: "/does-not-exist" }),
    ).rejects.toThrow(/does-not-exist/);
  });

  it("renders an issue packet with the fields an agent acts on", async () => {
    const engine = context.engine;
    const run = await engine.request("check.run", { root, app: root });
    const id = run.issues[0]!.id;

    const text = await call("drumlin_get_issue", { id });

    expect(text).toContain(id);
    expect(text).toContain("Problem:");
    expect(text).toContain("Done when:");
    expect(text).toContain("Start in:");
    expect(text).toContain("Re-test with:");
  });

  /**
   * The guardrail restated in the packet itself, because the tool description
   * is read once and the packet is read every time.
   */
  it("tells the agent it cannot close the issue", async () => {
    const run = await context.engine.request("check.run", { root, app: root });
    const text = await call("drumlin_get_issue", { id: run.issues[0]!.id });

    expect(text).toMatch(/cannot close this issue/i);
    expect(text).toContain("drumlin accept");
  });

  it("reports findings and states its own scope", async () => {
    const text = await call("drumlin_check_changed");

    expect(text).toContain("Scope:");
    expect(text).toMatch(/finding\(s\)|No findings/);
  });

  it("honours the severity floor", async () => {
    const all = await call("drumlin_check_changed");
    const critical = await call("drumlin_check_changed", {
      severity: "critical",
    });

    expect(all).not.toBe(critical);
    expect(critical).not.toMatch(/\[(info|low|medium)\]/);
  });

  it("points from a finding to the packet that explains it", async () => {
    const text = await call("drumlin_check_changed");
    if (text.startsWith("No findings")) return;
    expect(text).toContain("drumlin_get_issue with id");
  });

  /**
   * The surface and the engine allowlist have to agree. Two lists that encode
   * the same policy will drift, and the drift is silent: a tool calling a
   * method the engine does not consider agent-readable still works.
   */
  it("calls only methods the engine considers agent-readable", () => {
    expect([...AGENT_READABLE_METHODS].sort()).toEqual([
      "check.run",
      "graph.flow",
      "issue.get",
      "project.summary",
    ]);
    expect(TOOL_NAMES).toHaveLength(AGENT_READABLE_METHODS.length);
  });
});
