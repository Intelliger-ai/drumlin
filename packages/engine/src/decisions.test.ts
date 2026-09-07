import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRepo, IssueStore } from "@drumlin/repo";
import type { Issue } from "@drumlin/model";
import { InProcessEngine } from "./in-process.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../indexer/fixtures/mixed-app",
);

/** What a person is attested with, once `classifyCaller` has agreed. */
const ATTESTED = ["interactive terminal", "confirmed at an interactive prompt"];

/**
 * Who is allowed to make an issue go away.
 *
 * `accepted` is the only status that silences a finding, so it is the only one
 * worth attacking. Milestone B kept it off the MCP tool list and treated that
 * as sufficient; it was not, because the agent has a shell and the socket is
 * mode 0600 under the same user. These tests pin the two halves of the fix:
 * an accept must carry evidence a person was involved, and an agent gets a
 * path that argues instead of a path that acts.
 */
describe("accepting and proposing", () => {
  let root: string;
  const engine = new InProcessEngine();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-decide-"));
    cpSync(FIXTURE, root, { recursive: true });
    initRepo(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Read past the engine, so assertions see what was actually persisted. */
  function stored(id: string): Issue {
    const issue = new IssueStore(root).read(id);
    if (!issue) throw new Error(`no stored issue ${id}`);
    return issue;
  }

  async function anIssue(): Promise<Issue> {
    await engine.request("check.run", { root });
    const { issues } = await engine.request("issues.list", { root });
    const open = issues.find((issue) => issue.status !== "accepted");
    if (!open) throw new Error("fixture produced no open issue");
    return open;
  }

  describe("accept", () => {
    it("refuses an accept that carries no attestation", async () => {
      const issue = await anIssue();

      await expect(
        engine.request("issue.accept", {
          root,
          id: issue.id,
          reason: "looks fine to me",
          attestation: [],
        }),
      ).rejects.toThrow(/attestation/);
    });

    it("refuses whitespace dressed up as attestation", async () => {
      const issue = await anIssue();

      await expect(
        engine.request("issue.accept", {
          root,
          id: issue.id,
          reason: "looks fine to me",
          attestation: ["", "   "],
        }),
      ).rejects.toThrow(/attestation/);
    });

    it("records the evidence alongside the decision", async () => {
      const issue = await anIssue();

      const { issue: accepted } = await engine.request("issue.accept", {
        root,
        id: issue.id,
        reason: "the empty state is the design",
        attestation: ATTESTED,
      });

      const event = accepted.history?.find((entry) => entry.to === "accepted");
      expect(accepted.status).toBe("accepted");
      expect(event?.by).toBe("human");
      expect(event?.attestation).toEqual(ATTESTED);
      // On the issue too, so reading the file answers "why is this silent?"
      // without walking an event log.
      expect(accepted.acceptedReason).toBe("the empty state is the design");
    });

    it("still refuses an accept with no reason", async () => {
      const issue = await anIssue();

      await expect(
        engine.request("issue.accept", {
          root,
          id: issue.id,
          reason: "  ",
          attestation: ATTESTED,
        }),
      ).rejects.toThrow(/reason/);
    });
  });

  describe("propose", () => {
    it("records an agent's case without changing anything", async () => {
      const issue = await anIssue();

      const { issue: proposed } = await engine.request("issue.propose", {
        root,
        id: issue.id,
        reason: "this route only awaits auth() and renders static copy",
        by: "agent",
        session: "conv-1",
      });

      // The whole point: the finding is still reported.
      expect(proposed.status).toBe(issue.status);
      expect(proposed.proposals).toHaveLength(1);
      expect(proposed.proposals?.[0]).toMatchObject({
        kind: "accept",
        by: "agent",
        state: "pending",
        session: "conv-1",
      });
    });

    it("keeps the agent's reasoning verbatim", async () => {
      const issue = await anIssue();
      const reason =
        "The `await` here is auth(), not a fetch. Nothing renders from it.";

      const { issue: proposed } = await engine.request("issue.propose", {
        root,
        id: issue.id,
        reason,
        by: "agent",
      });

      expect(proposed.proposals?.[0]?.reason).toBe(reason);
    });

    it("refuses a second proposal while one is still pending", async () => {
      const issue = await anIssue();
      const base = { root, id: issue.id, by: "agent" } as const;

      await engine.request("issue.propose", { ...base, reason: "first" });

      // Otherwise an agent that is not getting its way just proposes harder.
      await expect(
        engine.request("issue.propose", { ...base, reason: "second" }),
      ).rejects.toThrow(/awaiting a decision/);
    });

    it("refuses to propose against something already accepted", async () => {
      const issue = await anIssue();
      await engine.request("issue.accept", {
        root,
        id: issue.id,
        reason: "intended",
        attestation: ATTESTED,
      });

      await expect(
        engine.request("issue.propose", {
          root,
          id: issue.id,
          reason: "let me argue anyway",
          by: "agent",
        }),
      ).rejects.toThrow(/already accepted/);
    });

    it("needs a reason, because the reason is the entire proposal", async () => {
      const issue = await anIssue();

      await expect(
        engine.request("issue.propose", {
          root,
          id: issue.id,
          reason: "   ",
          by: "agent",
        }),
      ).rejects.toThrow(/reason/);
    });
  });

  describe("granting and declining", () => {
    it("marks the proposal granted rather than discarding it", async () => {
      const issue = await anIssue();
      const { index } = await engine.request("issue.propose", {
        root,
        id: issue.id,
        reason: "the await is auth(), not a fetch",
        by: "agent",
      });

      const { issue: accepted } = await engine.request("issue.accept", {
        root,
        id: issue.id,
        reason: "agreed, the agent read it right",
        attestation: ATTESTED,
        grants: index,
      });

      // The argument that persuaded someone survives next to the decision.
      expect(accepted.proposals?.[index]).toMatchObject({
        state: "granted",
        reason: "the await is auth(), not a fetch",
        decidedNote: "agreed, the agent read it right",
      });
      expect(accepted.status).toBe("accepted");
    });

    it("declines without touching the issue's status", async () => {
      const issue = await anIssue();
      await engine.request("issue.propose", {
        root,
        id: issue.id,
        reason: "I think this is a false positive",
        by: "agent",
      });

      const { issue: declined, declined: count } = await engine.request(
        "issue.decline",
        { root, id: issue.id, note: "no, the error state is genuinely missing" },
      );

      expect(count).toBe(1);
      expect(declined.status).toBe(issue.status);
      expect(declined.proposals?.[0]).toMatchObject({
        state: "declined",
        decidedNote: "no, the error state is genuinely missing",
      });
    });

    it("lets an agent try again after a decline", async () => {
      const issue = await anIssue();
      const base = { root, id: issue.id, by: "agent" } as const;

      await engine.request("issue.propose", { ...base, reason: "first try" });
      await engine.request("issue.decline", { root, id: issue.id });

      // A declined proposal is a closed conversation, not a permanent ban:
      // the agent may have learned something since.
      const { issue: again } = await engine.request("issue.propose", {
        ...base,
        reason: "second try, with the file this time",
      });

      expect(again.proposals).toHaveLength(2);
      expect(again.proposals?.[1]?.state).toBe("pending");
    });

    it("reports nothing declined when there was nothing pending", async () => {
      const issue = await anIssue();

      const { declined } = await engine.request("issue.decline", {
        root,
        id: issue.id,
      });

      expect(declined).toBe(0);
    });
  });

  /**
   * Undoing an acceptance.
   *
   * The gap that made the caller check less useful than it looked: a wrong
   * acceptance was permanent. These pin the properties that matter — the
   * finding comes back, both reasons survive, and an acceptance that was never
   * attested says so on the way out.
   */
  describe("revoke", () => {
    async function accepted(): Promise<Issue> {
      const issue = await anIssue();
      const { issue: result } = await engine.request("issue.accept", {
        root,
        id: issue.id,
        reason: "shipping the beta without it",
        attestation: ATTESTED,
      });
      return result;
    }

    it("puts an accepted finding back on the report", async () => {
      const issue = await accepted();

      const { issue: revoked } = await engine.request("issue.revoke", {
        root,
        id: issue.id,
        reason: "beta is over",
        by: "human",
      });

      expect(revoked.status).toBe("confirmed");
      // Not merely un-flagged: it has to come back through `check`, which
      // filters accepted issues out of what it reports.
      const { issues } = await engine.request("check.run", { root });
      expect(issues.map((reported) => reported.id)).toContain(issue.id);
    });

    it("keeps both decisions, and the reason each gave", async () => {
      const issue = await accepted();

      const { issue: revoked, wasAcceptedFor } = await engine.request(
        "issue.revoke",
        { root, id: issue.id, reason: "beta is over", by: "human" },
      );

      expect(wasAcceptedFor).toBe("shipping the beta without it");
      // The acceptance is not rewritten out of existence; it happened.
      expect(
        revoked.history?.map((event) => [event.to, event.note]),
      ).toEqual(
        expect.arrayContaining([
          ["accepted", "shipping the beta without it"],
          ["confirmed", "beta is over"],
        ]),
      );
      // But it no longer reads as accepted at a glance.
      expect(revoked.acceptedReason).toBeUndefined();
    });

    it("reports an acceptance that was never attested", async () => {
      const issue = await anIssue();

      // What the forged acceptance in the first dogfooding session looked
      // like: `by: human` with nothing establishing a human. Written directly
      // because `issue.accept` now refuses to produce one.
      const store = new IssueStore(root);
      const before = store.read(issue.id);
      if (!before) throw new Error("missing issue");
      store.write({
        ...before,
        status: "accepted",
        acceptedReason: "not a real problem",
        history: [
          ...(before.history ?? []),
          {
            at: new Date().toISOString(),
            from: before.status,
            to: "accepted",
            by: "human",
          },
        ],
      });
      store.flush();

      const { accepted: listed } = await engine.request("issues.accepted", {
        root,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.attested).toBe(false);

      const { wasAttested } = await engine.request("issue.revoke", {
        root,
        id: issue.id,
        reason: "nobody remembers deciding this",
        by: "human",
      });
      expect(wasAttested).toBe(false);
    });

    it("distinguishes an attested acceptance from a bare one", async () => {
      const issue = await accepted();

      const { accepted: listed } = await engine.request("issues.accepted", {
        root,
      });

      expect(listed.find((entry) => entry.id === issue.id)?.attested).toBe(
        true,
      );
    });

    it("requires a reason, because it overturns a recorded decision", async () => {
      const issue = await accepted();

      await expect(
        engine.request("issue.revoke", {
          root,
          id: issue.id,
          reason: "   ",
          by: "human",
        }),
      ).rejects.toThrow(/needs a reason/i);
    });

    it("refuses to revoke something that was never accepted", async () => {
      const issue = await anIssue();

      await expect(
        engine.request("issue.revoke", {
          root,
          id: issue.id,
          reason: "wrong id",
          by: "human",
        }),
      ).rejects.toThrow(/not accepted/i);
    });

    /**
     * Revoking is cheaper than accepting — no terminal, no typed confirmation,
     * because it can only add work rather than hide it. It is still not an
     * agent's call: a revoked issue lands in `confirmed`, which asserts that
     * somebody with standing considers it real. The ownership table refuses
     * that, so this needs no separate rule to enforce.
     */
    it("does not let an agent overturn a person's decision", async () => {
      const issue = await accepted();

      await expect(
        engine.request("issue.revoke", {
          root,
          id: issue.id,
          reason: "I disagree with this acceptance",
          by: "agent",
        }),
      ).rejects.toThrow(/only rule-engine or human/i);

      expect(stored(issue.id).status).toBe("accepted");
    });
  });
});
