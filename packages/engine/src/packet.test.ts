import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRepo } from "@drumlin/repo";
import { InProcessEngine } from "./in-process.js";
import type { IssuePacket } from "./types.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../indexer/fixtures/mixed-app",
);

/**
 * The issue packet is the whole agent-facing product surface, so the property
 * worth testing is not that fields are populated but that nothing in it is
 * invented. An agent handed a plausible-sounding actor or acceptance criterion
 * will act on it and cannot tell it apart from the graph facts beside it.
 */
describe("issue packets", () => {
  let root: string;
  const engine = new InProcessEngine();
  let packets: IssuePacket[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "drumlin-packet-"));
    cpSync(FIXTURE, root, { recursive: true });
    initRepo(root);

    const run = await engine.request("check.run", { root, app: root });
    packets = [];
    for (const issue of run.issues) {
      const result = await engine.request("issue.get", {
        root,
        app: root,
        id: issue.id,
      });
      packets.push(result.packet);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("assembles a packet for every issue the check produced", () => {
    expect(packets.length).toBeGreaterThan(5);
  });

  it("resolves an issue id case-insensitively and without the prefix", async () => {
    const id = packets[0]!.issue.id;
    const bare = id.replace(/^UX-/, "");

    for (const spelling of [id, id.toLowerCase(), bare]) {
      const result = await engine.request("issue.get", {
        root,
        app: root,
        id: spelling,
      });
      expect(result.packet.issue.id, spelling).toBe(id);
    }
  });

  /**
   * Fails loudly, and says what to do about it. An agent that gets an empty
   * result back reads it as "no problem here" and moves on; an error naming
   * `drumlin check` and `drumlin init` tells it which of the two things went
   * wrong.
   */
  it("rejects an unknown issue with the command that would fix it", async () => {
    await expect(
      engine.request("issue.get", { root, app: root, id: "UX-9999" }),
    ).rejects.toThrow(/UX-9999.*drumlin check/s);
  });

  it("always carries the fields an agent needs to act", () => {
    for (const packet of packets) {
      expect(packet.currentBehaviour, packet.issue.id).toBeTruthy();
      expect(packet.acceptance.length, packet.issue.id).toBeGreaterThan(0);
      expect(packet.retestCommand, packet.issue.id).toContain(
        `--rule ${packet.issue.rule.id}`,
      );
    }
  });

  /**
   * The load-bearing one. A packet that points at no file sends the agent
   * hunting, and hunting is where it edits the wrong thing.
   */
  it("points at files that exist in the graph", () => {
    for (const packet of packets) {
      expect(packet.likelyFiles.length, packet.issue.id).toBeGreaterThan(0);
      for (const file of packet.likelyFiles) {
        expect(file, packet.issue.id).not.toMatch(/^\//);
      }
    }
  });

  it("orders likely files by how specific the pointer is", () => {
    // Evidence that cited a line knows more than the screen's own file does.
    const withEvidence = packets.find((packet) =>
      packet.issue.evidence.some((item) => item.location?.file),
    );
    expect(withEvidence).toBeDefined();

    const first = withEvidence!.issue.evidence.find(
      (item) => item.location?.file,
    )!.location!.file;
    expect(withEvidence!.likelyFiles[0]).toBe(first);
  });

  it("names no actor, because this fixture has no confirmed role model", () => {
    // Provenance, not omission: the permissions model is inferred here, and an
    // inferred actor stated as fact is exactly the failure the packet format
    // exists to prevent.
    for (const packet of packets) {
      expect(packet.actor, packet.issue.id).toBeUndefined();
    }
  });

  it("states the target behaviour only when the rule proposed one", () => {
    for (const packet of packets) {
      if (packet.issue.proposal) {
        expect(packet.targetBehaviour).toBe(packet.issue.proposal);
      } else {
        expect(packet.targetBehaviour).toBeUndefined();
      }
    }
  });

  it("includes the graph neighbourhood for a screen-scoped issue", () => {
    const screenIssue = packets.find((packet) => packet.neighbourhood);
    expect(screenIssue).toBeDefined();

    const flow = screenIssue!.neighbourhood!;
    expect(flow.screen.route ?? flow.screen.id).toBeTruthy();
    expect(Array.isArray(flow.inbound)).toBe(true);
    expect(Array.isArray(flow.outbound)).toBe(true);
  });

  it("derives constraints from the graph rather than offering advice", () => {
    const constraints = packets.flatMap((packet) => packet.constraints);
    expect(constraints.length).toBeGreaterThan(0);
    // Every constraint should be a checkable statement about this codebase.
    for (const constraint of constraints) {
      expect(constraint).not.toMatch(/be careful|make sure|consider/i);
    }
  });
});
