import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRepo, IssueStore } from "@drumlin/repo";
import { mayTransition } from "@drumlin/model";
import type { Issue } from "@drumlin/model";
import { InProcessEngine } from "./in-process.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../indexer/fixtures/mixed-app",
);

/**
 * Verification ownership.
 *
 * The rule is that only the verifier sets `resolved`, and an agent saying it
 * fixed something is a hint about what to test rather than proof that it worked.
 * These tests exist because the previous version of that rule was a table of
 * strings nothing consulted — the guarantee held only because no code had yet
 * tried to break it.
 *
 * See vault/Loop/Verification Ownership.md.
 */
describe("verification ownership", () => {
  let root: string;
  const engine = new InProcessEngine();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-verify-"));
    cpSync(FIXTURE, root, { recursive: true });
    initRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function check(): Promise<Issue[]> {
    const { issues } = await engine.request("check.run", {
      root,
      cache: false,
    });
    return issues;
  }

  /**
   * Read an issue back off disk.
   *
   * Deliberately not `issue.get`, which returns an assembled packet for an
   * agent rather than the record. What matters here is what was persisted,
   * because that is what survives the process.
   */
  function stored(id: string): Issue {
    const issue = new IssueStore(root).read(id);
    expect(issue, `${id} should be on disk`).toBeDefined();
    return issue!;
  }

  /**
   * Actually fix the destructive-action finding.
   *
   * The rule looks at the call site rather than the action, so this has to go
   * in the component that submits the form.
   */
  function confirmDeletion(): void {
    const page = join(root, "app/invoices/[id]/page.tsx");
    const source = readFileSync(page, "utf8");
    const fixed = source.replace(
      "<form action={deleteInvoice}>",
      `<form action={deleteInvoice} onSubmit={(e) => { if (!window.confirm("Are you sure? This cannot be undone.")) e.preventDefault(); }}>`,
    );

    // `String.replace` on a pattern that does not match returns the input
    // unchanged and says nothing. That silently turns "verify a real fix" into
    // "verify no change at all", which passes or fails for reasons unrelated
    // to what the test is about.
    expect(fixed, "fixture markup changed; update this helper").not.toBe(
      source,
    );
    writeFileSync(page, fixed, "utf8");
  }

  /** A finding that a source edit can genuinely fix. */
  async function fixableIssue(): Promise<Issue> {
    const issues = await check();
    const issue = issues.find(
      (candidate) => candidate.rule.id === "flow.destructive.no-confirm",
    );
    expect(
      issue,
      "fixture should report an unconfirmed destructive action",
    ).toBeDefined();
    return issue!;
  }

  describe("the state machine", () => {
    it("refuses to let an agent resolve anything", () => {
      // The single most important assertion in the suite. Every other guard is
      // a convenience on top of this one.
      const verdict = mayTransition("agent", "verifying", "resolved");
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("Only verifier");
      // The refusal has to say what to do instead, or it just reads as a bug.
      expect(verdict.reason).toContain("drumlin claim");
    });

    it("refuses a human too", () => {
      // Not an oversight. A person who wants a finding to stop appearing has
      // `accept`, which records that it is deliberate. `resolved` is a claim
      // that the problem is gone, and that is checkable, so it gets checked.
      expect(mayTransition("human", "verifying", "resolved").ok).toBe(false);
    });

    it("lets an agent claim a fix", () => {
      expect(
        mayTransition("agent", "in_progress", "candidate_resolved").ok,
      ).toBe(true);
    });

    it("gives a claim nowhere to go except the verifier", () => {
      // What makes the previous test safe: the state an agent can reach leads
      // only to `verifying`, which is the verifier's alone.
      expect(mayTransition("agent", "candidate_resolved", "verifying").ok).toBe(
        false,
      );
      expect(
        mayTransition("verifier", "candidate_resolved", "verifying").ok,
      ).toBe(true);
    });

    it("still refuses moves that make no sense, whoever asks", () => {
      const verdict = mayTransition("verifier", "detected", "resolved");
      expect(verdict.ok).toBe(false);
      expect(verdict.reason).toContain("cannot go from detected to resolved");
    });
  });

  describe("claiming", () => {
    it("records the claim without resolving anything", async () => {
      const issue = await fixableIssue();

      const { issue: claimed } = await engine.request("issue.claim", {
        root,
        id: issue.id,
        note: "added a confirm dialog",
        by: "agent",
        verify: false,
      });

      expect(claimed.status).toBe("candidate_resolved");
      expect(claimed.status).not.toBe("resolved");
      expect(claimed.claims?.at(-1)?.note).toBe("added a confirm dialog");
      expect(claimed.claims?.at(-1)?.by).toBe("agent");
    });

    it("records one transition, not an invented workflow", async () => {
      const issue = await fixableIssue();
      expect(issue.status).toBe("detected");

      const { issue: claimed } = await engine.request("issue.claim", {
        root,
        id: issue.id,
        note: "added a confirm dialog",
        by: "agent",
        verify: false,
      });

      // An earlier version walked `detected → confirmed → ready → assigned →
      // in_progress → candidate_resolved` so that every edge would be one the
      // state machine already had. That wrote four events describing things
      // that never happened — nobody confirmed this finding or assigned it —
      // and attributed them to the agent. One honest edge beats five legal
      // fictions.
      const added = (claimed.history ?? []).slice(issue.history?.length ?? 0);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        from: "detected",
        to: "candidate_resolved",
        by: "agent",
        note: "added a confirm dialog",
      });
    });

    it("needs to say what changed", async () => {
      const issue = await fixableIssue();
      await expect(
        engine.request("issue.claim", {
          root,
          id: issue.id,
          note: "   ",
          by: "agent",
        }),
      ).rejects.toThrow(/what changed/i);
    });

    it("refuses on an accepted issue", async () => {
      const issue = await fixableIssue();
      await engine.request("issue.accept", {
        root,
        id: issue.id,
        reason: "confirmed elsewhere in the flow",
        attestation: ["interactive terminal"],
      });

      await expect(
        engine.request("issue.claim", {
          root,
          id: issue.id,
          note: "fixed",
          by: "agent",
        }),
      ).rejects.toThrow(/accepted/);
    });
  });

  describe("verifying", () => {
    it("refuses to resolve while the rule still fires", async () => {
      const issue = await fixableIssue();

      // The claim is a lie. Nothing in the source changed.
      const { verification } = await engine.request("issue.claim", {
        root,
        id: issue.id,
        note: "I have fixed this, please resolve it",
        by: "agent",
        verify: true,
      });

      expect(verification?.outcome).toBe("present");
      expect(verification?.by).toBe("verifier");

      expect(stored(issue.id).status).not.toBe("resolved");
    });

    it("keeps the failed attempt on the record", async () => {
      const issue = await fixableIssue();
      await engine.request("issue.claim", {
        root,
        id: issue.id,
        note: "trust me",
        by: "agent",
        verify: true,
      });

      const after = stored(issue.id);
      // The failures are the useful half: an issue claimed fixed three times
      // and never verified is a different situation from an untouched one.
      expect(after.verifications).toHaveLength(1);
      expect(after.verifications?.[0]?.outcome).toBe("present");
      expect(after.claims?.[0]?.outcome).toBe("present");
    });

    it("carries the claim as context without using it", async () => {
      const issue = await fixableIssue();
      await engine.request("issue.claim", {
        root,
        id: issue.id,
        note: "wrapped it in a confirm()",
        by: "agent",
        verify: true,
      });

      const verification = stored(issue.id).verifications?.[0];
      expect(verification?.claim).toBe("wrapped it in a confirm()");
      // Recorded, and not among the reasons for the verdict.
      expect(verification?.evidence.join(" ")).not.toContain("confirm()");
    });

    it("resolves when the rule genuinely stops firing", async () => {
      const issue = await fixableIssue();

      // A real fix at the call site, which is where the rule looks: wrap the
      // destructive submit in a confirmation. Not a comment — the indexer
      // strips those on purpose, because a comment promising a dialog is not
      // a dialog.
      confirmDeletion();

      const result = await engine.request("issue.verify", {
        root,
        id: issue.id,
      });
      const report = result.verified[0];

      expect(report?.outcome).toBe("gone");
      expect(report?.status).toBe("resolved");
      expect(result.resolved).toContain(issue.id);
      expect(stored(issue.id).status).toBe("resolved");
    });

    it("says out loud that a static pass is not a runtime one", async () => {
      const issue = await fixableIssue();
      confirmDeletion();

      const result = await engine.request("issue.verify", {
        root,
        id: issue.id,
      });

      // The honesty requirement. A rule that stopped matching the source is
      // not the experience having been checked, and an issue resolved on that
      // basis must not read a year later as though a browser confirmed it.
      expect(result.verified[0]?.evidence.join(" ")).toContain(
        "static check only",
      );
      expect(stored(issue.id).verifications?.at(-1)?.kind).toBe("static");
    });

    it("attributes the resolution to the verifier", async () => {
      const issue = await fixableIssue();
      confirmDeletion();
      await engine.request("issue.verify", { root, id: issue.id });

      const history = stored(issue.id).history ?? [];
      const resolution = history.find((event) => event.to === "resolved");
      expect(resolution?.by).toBe("verifier");
      // And it passed through `verifying`, so the record shows a check
      // happened rather than just a status landing on `resolved`.
      expect(history.some((event) => event.to === "verifying")).toBe(true);
    });

    it("will not resolve because the screen was deleted", async () => {
      const issues = await check();
      const target = issues.find(
        (issue) => issue.target.node === "screen.reports",
      );
      expect(target).toBeDefined();

      // The loophole. Delete the subject and every rule about it goes quiet,
      // which is indistinguishable from having fixed it — so it must not count.
      rmSync(join(root, "app/reports"), { recursive: true, force: true });

      const result = await engine.request("issue.verify", {
        root,
        id: target!.id,
      });
      const report = result.verified[0];

      expect(report?.outcome).toBe("vanished");
      expect(report?.status).not.toBe("resolved");
      expect(result.resolved).toHaveLength(0);
      expect(report?.summary).toContain("deletion");
    });

    it("will not resolve because the rule was switched off", async () => {
      const issue = await fixableIssue();

      // The other loophole, and a cheaper one to exploit than deleting code:
      // disable the rule and every issue it ever raised goes quiet. An earlier
      // version of the verifier inferred "did the rule run" from whether any
      // finding carried its id, which made this indistinguishable from a fix —
      // and, worse, made a genuinely clean codebase unverifiable for the same
      // reason.
      const config = join(root, ".drumlin/config.yaml");
      const source = readFileSync(config, "utf8");
      // Editing the key `drumlin init` already wrote. Appending a second
      // `rules:` block makes the document invalid, `readConfig` falls back to
      // defaults, and the rule stays enabled — so the test would pass while
      // testing nothing.
      const disabled = source.replace(
        "disabled: []",
        "disabled: [flow.destructive.no-confirm]",
      );
      expect(disabled).not.toBe(source);
      writeFileSync(config, disabled, "utf8");

      const result = await engine.request("issue.verify", {
        root,
        id: issue.id,
      });
      const report = result.verified[0];

      expect(report?.outcome).toBe("inconclusive");
      expect(report?.status).not.toBe("resolved");
      expect(report?.evidence.join(" ")).toContain("did not run");
    });

    it("verifies every unchecked claim when given no id", async () => {
      const issues = await check();
      const two = issues.slice(0, 2);
      for (const issue of two) {
        await engine.request("issue.claim", {
          root,
          id: issue.id,
          note: "done",
          by: "agent",
          verify: false,
        });
      }

      const result = await engine.request("issue.verify", { root });
      expect(result.verified.map((entry) => entry.id).sort()).toEqual(
        two.map((issue) => issue.id).sort(),
      );
    });

    it("does not re-verify a claim it has already checked", async () => {
      const issue = await fixableIssue();
      await engine.request("issue.claim", {
        root,
        id: issue.id,
        note: "done",
        by: "agent",
        verify: true,
      });

      // A full uncached run is expensive, and re-running it over settled claims
      // would make `drumlin verify` cost more every time it is used.
      const again = await engine.request("issue.verify", { root });
      expect(again.verified).toHaveLength(0);
    });

    it("names the verifier, never the claimant", async () => {
      const issue = await fixableIssue();
      await engine.request("issue.claim", {
        root,
        id: issue.id,
        note: "done",
        by: "agent",
        verify: true,
      });

      for (const verification of stored(issue.id).verifications ?? []) {
        expect(verification.by).toBe("verifier");
      }
    });
  });

  describe("regressions", () => {
    it("reopens a resolved issue when the rule fires again", async () => {
      // `reconcile` does this, and it is the reason `rule-engine` is allowed to
      // set `reopened` alongside the verifier: the rule firing again is the
      // same check that found the problem, reporting that it is back.
      expect(mayTransition("rule-engine", "resolved", "reopened").ok).toBe(
        true,
      );
    });
  });
});
