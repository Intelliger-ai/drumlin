import { describe, expect, it, vi } from "vitest";
import type { Engine } from "@drumlin/engine";
import { ReadOnlyEngine } from "./readonly.js";
import { TOOLS, TOOL_ANNOTATIONS, TOOL_NAMES } from "./tools.js";

/**
 * The point of these tests is the shape of the surface, not the prose.
 *
 * A write tool appearing here later would be a change of policy dressed as a
 * feature: an agent that can close its own issues is an agent grading its own
 * homework, and Context/11 gives `resolved` to a verifier and `accepted` to a
 * human for exactly that reason.
 */
describe("the MCP tool surface", () => {
  it("is exactly the four read-only tools", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "drumlin_project_summary",
      "drumlin_get_flow",
      "drumlin_get_issue",
      "drumlin_check_changed",
    ]);
  });

  it("exposes nothing that writes, resolves, or reaches a shell", () => {
    const forbidden = [
      "submit",
      "resolve",
      "accept",
      "verify",
      "record",
      "write",
      "exec",
      "shell",
      "run_command",
      "bash",
    ];

    for (const name of TOOL_NAMES) {
      for (const word of forbidden) {
        expect(name).not.toContain(word);
      }
    }
  });

  it("declares every tool read-only to the host", () => {
    expect(TOOL_ANNOTATIONS.readOnlyHint).toBe(true);
    expect(TOOL_ANNOTATIONS.destructiveHint).toBe(false);
    expect(TOOL_ANNOTATIONS.openWorldHint).toBe(false);
  });

  it("gives every tool a description an agent can act on", () => {
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });

  it("takes the workspace from its context, never from a tool argument", () => {
    for (const tool of TOOLS) {
      const keys = Object.keys(tool.inputSchema);
      expect(keys).not.toContain("root");
      expect(keys).not.toContain("app");
      expect(keys).not.toContain("cwd");
      expect(keys).not.toContain("path");
    }
  });
});

/**
 * The boundary behind the surface.
 *
 * Every tool holds an `Engine`, and an `Engine` can accept an issue. Without
 * this wrapper the read-only guarantee is a naming test, which holds right up
 * until somebody adds a fifth tool.
 */
describe("the read-only engine wrapper", () => {
  const inner = (): Engine => ({ request: vi.fn().mockResolvedValue({}) });

  it("passes through the four agent-readable methods", async () => {
    const spy = inner();
    const engine = new ReadOnlyEngine(spy);

    for (const method of [
      "project.summary",
      "graph.flow",
      "issue.get",
      "check.run",
    ] as const) {
      await engine.request(method, { root: "/tmp" } as never);
    }

    expect(spy.request).toHaveBeenCalledTimes(4);
  });

  it("refuses to accept an issue, and says who can", async () => {
    const spy = inner();

    await expect(
      new ReadOnlyEngine(spy).request("issue.accept", {
        root: "/tmp",
        id: "UX-1",
        reason: "because the agent said so",
        // Forged on purpose. The MCP surface must refuse this before anything
        // looks at whether the attestation is believable.
        attestation: ["definitely a human, trust me"],
      }),
    ).rejects.toThrow(/read-only.*drumlin accept/s);

    // Not merely reported as refused — never forwarded.
    expect(spy.request).not.toHaveBeenCalled();
  });

  it("refuses every other engine method too", async () => {
    for (const method of [
      "workspace.open",
      "context.infer",
      "issues.list",
      "session.start",
      "session.diff",
      "session.end",
      "graph.get",
    ] as const) {
      const spy = inner();
      await expect(
        new ReadOnlyEngine(spy).request(method, { root: "/tmp" } as never),
        method,
      ).rejects.toThrow(/not available to an agent/);
      expect(spy.request, method).not.toHaveBeenCalled();
    }
  });
});
