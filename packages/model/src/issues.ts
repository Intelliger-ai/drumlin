import { z } from "zod";
import {
  EvidenceSchema,
  FindingTargetSchema,
  RuleClassificationSchema,
  SeveritySchema,
} from "./findings.js";

/**
 * Issues are durable product objects, not disposable warnings. The state machine
 * and its ownership rules are what make `resolved` mean something.
 *
 * See vault/Loop/Issue Lifecycle.md and Context/11 Issue Lifecycle and Resolution Protocol.md
 */

export const ISSUE_STATUSES = [
  "detected",
  "confirmed",
  "ready",
  "assigned",
  "in_progress",
  "candidate_resolved",
  "verifying",
  "resolved",
  "reopened",
  "accepted",
  "superseded",
] as const;
export const IssueStatusSchema = z.enum(ISSUE_STATUSES);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

/**
 * Who caused a transition.
 *
 * A closed set rather than a free string, because "only a human may accept"
 * cannot be enforced against a field any caller can fill in with the word
 * "human". Whether a given actor claim is *believed* is a separate problem —
 * see `attest` in the engine — but it cannot even be expressed without being
 * one of these.
 */
export const ACTORS = ["human", "agent", "rule-engine", "verifier"] as const;
export const ActorSchema = z.enum(ACTORS);
export type Actor = z.infer<typeof ActorSchema>;

/**
 * Who is allowed to move an issue into each state.
 *
 * `resolved` is reachable only by the verifier. That single constraint is what
 * stops an agent's claim from closing its own issue.
 *
 * This was a `Record<IssueStatus, string>` of hyphenated prose until it was
 * given something to enforce. It read as a specification and was in fact a
 * comment: no code consulted it, nothing could, and the two states whose
 * ownership is the entire point — `accepted` and `resolved` — were each
 * protected by an unrelated accident instead. `accepted` was safe because it
 * was not an MCP method, until an agent ran the CLI; `resolved` was safe
 * because nothing set it at all.
 */
export const STATE_OWNERS: Record<IssueStatus, readonly Actor[]> = {
  detected: ["rule-engine"],
  confirmed: ["rule-engine", "human"],
  ready: ["rule-engine"],
  assigned: ["human", "agent"],
  in_progress: ["agent"],
  /** The worker's claim. Deliberately writable by an agent: see `mayTransition`. */
  candidate_resolved: ["agent", "human"],
  verifying: ["verifier"],
  resolved: ["verifier"],
  /**
   * The rule engine belongs here alongside the verifier. A rule firing again on
   * an issue that was resolved is not a weaker signal than a verification — it
   * is the same check that found the problem originally, reporting that it is
   * back. Reserving `reopened` for the verifier would mean a regression sits
   * silently in `resolved` until something asks the verifier to look.
   */
  reopened: ["verifier", "rule-engine"],
  accepted: ["human"],
  superseded: ["rule-engine", "human"],
};

/**
 * Legal transitions. Anything absent here is rejected by `canTransition`.
 *
 * `candidate_resolved` is reachable from every state where claiming a fix is a
 * coherent thing to say, rather than only from `in_progress`. The narrower
 * version modelled an orchestration that does not happen: in practice a rule
 * detects something, somebody fixes it, and somebody says so — nobody
 * confirmed it, assigned it, or started work on it. Requiring the walk meant
 * writing four transitions that never occurred into the history of every
 * claim, attributed to whoever happened to be claiming.
 *
 * The intermediate states are still real and still used by an orchestrator
 * that genuinely assigns work. They are just not on the path of somebody
 * reporting a fix.
 *
 * `verifying` is likewise reachable from every open state, because the
 * verifier does not need permission to look. Requiring a claim first would
 * mean `drumlin verify UX-1` could not check an issue nobody had claimed —
 * and whether a fix can be demonstrated has nothing to do with whether anyone
 * announced it. `accepted` is the one exception: it was deliberately
 * tolerated, and re-verifying it could only undo somebody's decision.
 */
const TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  detected: ["confirmed", "candidate_resolved", "verifying", "superseded"],
  confirmed: [
    "ready",
    "accepted",
    "candidate_resolved",
    "verifying",
    "superseded",
  ],
  ready: [
    "assigned",
    "accepted",
    "candidate_resolved",
    "verifying",
    "superseded",
  ],
  assigned: [
    "in_progress",
    "ready",
    "candidate_resolved",
    "verifying",
    "superseded",
  ],
  in_progress: ["candidate_resolved", "ready", "verifying", "superseded"],
  candidate_resolved: ["verifying", "superseded"],
  verifying: ["resolved", "reopened"],
  resolved: ["reopened", "superseded"],
  reopened: [
    "assigned",
    "in_progress",
    "accepted",
    "candidate_resolved",
    "verifying",
    "superseded",
  ],
  accepted: ["confirmed", "superseded"],
  superseded: [],
};

export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Why a transition was refused, in words the caller can be shown. */
export interface TransitionVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Whether `actor` may make this specific move.
 *
 * Two independent questions, and both have to pass. `canTransition` asks
 * whether the move makes sense at all; this also asks whether the mover is
 * entitled to make it. Checking only the first is how an agent ends up
 * resolving its own issue through a transition that is perfectly legal and
 * simply not its to make.
 *
 * The asymmetry worth noticing: an agent *may* set `candidate_resolved`. That
 * is not a lapse. An agent claiming to have fixed something is useful and
 * should be easy — it tells the verifier what to test. The claim just does not
 * close anything, because `candidate_resolved` only leads to `verifying`, and
 * from there only the verifier continues.
 */
export function mayTransition(
  actor: Actor,
  from: IssueStatus,
  to: IssueStatus,
): TransitionVerdict {
  if (!canTransition(from, to)) {
    const legal = TRANSITIONS[from];
    return {
      ok: false,
      reason:
        `An issue cannot go from ${from} to ${to}. ` +
        (legal.length === 0
          ? `${from} is terminal.`
          : `From ${from} the only moves are: ${legal.join(", ")}.`),
    };
  }

  const owners = STATE_OWNERS[to];
  if (!owners.includes(actor)) {
    return {
      ok: false,
      reason:
        `Only ${owners.join(" or ")} may move an issue to ${to}, and this ` +
        `came from ${actor}.` +
        (to === "resolved"
          ? " A fix is claimed with `drumlin claim`, which asks the verifier" +
            " to check it. Nothing else can mark an issue resolved."
          : ""),
    };
  }

  return { ok: true };
}

export function allowedTransitions(from: IssueStatus): readonly IssueStatus[] {
  return TRANSITIONS[from];
}

/** States in which the issue represents outstanding, unaccepted UX debt. */
export function isOpen(status: IssueStatus): boolean {
  return (
    status !== "resolved" && status !== "accepted" && status !== "superseded"
  );
}

export const IssueEventSchema = z.object({
  at: z.string(),
  from: IssueStatusSchema.optional(),
  to: IssueStatusSchema,
  by: ActorSchema,
  note: z.string().optional(),
  /**
   * How `by` was concluded, for transitions where it matters.
   *
   * An accept that says `by: human` with nothing here was recorded before
   * Drumlin checked, which is itself worth knowing when you are auditing who
   * silenced what. See `classifyCaller`.
   */
  attestation: z.array(z.string()).optional(),
});
export type IssueEvent = z.infer<typeof IssueEventSchema>;

/**
 * An agent's case for accepting a finding.
 *
 * The agent is often right — it has just read the code and may know the
 * finding is a false positive. What it must not do is act on being right. So
 * it argues here, the argument is recorded with its reasoning intact, and a
 * person grants or declines it. Nothing about a proposal changes the issue's
 * status.
 */
export const IssueProposalSchema = z.object({
  /** Only `accept` today. `resolved` is the verifier's, never a proposal's. */
  kind: z.literal("accept"),
  by: ActorSchema,
  at: z.string(),
  reason: z.string().min(1),
  /** The conversation it came from, when the host names one. */
  session: z.string().optional(),
  state: z.enum(["pending", "granted", "declined"]),
  /** Who resolved it, and why, once someone has. */
  decidedAt: z.string().optional(),
  decidedNote: z.string().optional(),
});
export type IssueProposal = z.infer<typeof IssueProposalSchema>;

/**
 * What kind of evidence a verification rests on.
 *
 * Recorded because these are not equally strong and the difference has to
 * survive into the record. `static` says a rule stopped firing, which is a fact
 * about the source and not about the experience; `runtime-replay` says a
 * browser did the thing and it worked. An issue resolved on the first should
 * not read the same as one resolved on the second a year later.
 */
export const VERIFICATION_KINDS = [
  "static",
  "graph-invariant",
  "runtime-replay",
  "acceptance-test",
  "human",
] as const;
export const VerificationKindSchema = z.enum(VERIFICATION_KINDS);
export type VerificationKind = z.infer<typeof VerificationKindSchema>;

/**
 * What the verifier concluded.
 *
 * `vanished` is the interesting one, and it exists because "the rule stopped
 * firing" and "the problem was fixed" are not the same sentence. If the screen
 * the finding was about no longer exists, the rule cannot fire whatever the
 * state of the product — deleting the feature would verify as cleanly as fixing
 * it. That is the same shape of hole as an agent stamping its own accept, so it
 * gets its own outcome and does not resolve anything.
 */
export const VERIFICATION_OUTCOMES = [
  "gone",
  "present",
  "vanished",
  "inconclusive",
] as const;
export const VerificationOutcomeSchema = z.enum(VERIFICATION_OUTCOMES);
export type VerificationOutcome = z.infer<typeof VerificationOutcomeSchema>;

/**
 * One verification attempt, kept whether it passed or not.
 *
 * Failures are the useful half. An issue that has been claimed fixed four times
 * and verified `present` four times is a different situation from one nobody has
 * touched, and only the record can tell them apart.
 */
export const VerificationSchema = z.object({
  at: z.string(),
  kind: VerificationKindSchema,
  outcome: VerificationOutcomeSchema,
  /** Never anything else. The field exists to make that visible in the file. */
  by: z.literal("verifier"),
  /** What was actually checked, in enough detail to be argued with. */
  evidence: z.array(z.string()),
  /** The claim that prompted this, if one did. Context, never input. */
  claim: z.string().optional(),
  note: z.string().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

/**
 * An agent's report that it has fixed something.
 *
 * Separate from `IssueProposal` because it asks for something different. A
 * proposal argues that a finding should be tolerated and needs a person.
 * A claim asserts the finding is gone, which is checkable, so it needs the
 * verifier instead — and being checkable is why an agent is allowed to file
 * one freely.
 */
export const IssueClaimSchema = z.object({
  by: ActorSchema,
  at: z.string(),
  /** What it changed and why it believes that fixed it. */
  note: z.string().min(1),
  session: z.string().optional(),
  /** Set once a verification has been run against this claim. */
  verifiedAt: z.string().optional(),
  outcome: VerificationOutcomeSchema.optional(),
});
export type IssueClaim = z.infer<typeof IssueClaimSchema>;

/**
 * A tracker this issue has been handed to.
 *
 * Recorded because export is not idempotent from the tracker's side: neither
 * Linear's CSV import nor `gh issue create` knows that `UX-0002` is already
 * there, so without a local record the second export silently duplicates
 * everything. `externalId` is filled in only if the developer tells us what the
 * tracker called it; the `UX-` id in the exported title is what makes the
 * mapping findable in the meantime.
 */
export const IssueExportSchema = z.object({
  /** `linear`, `github`, or whatever else grows a formatter. */
  target: z.string().min(1),
  at: z.string(),
  externalId: z.string().optional(),
  url: z.string().optional(),
});
export type IssueExport = z.infer<typeof IssueExportSchema>;

export const IssueSchema = z.object({
  /** `UX-0184`. Allocated once and never reused. */
  id: z.string().regex(/^UX-\d{4,}$/),
  /** Identity of the underlying problem, used to re-match across runs. */
  fingerprint: z.string().min(1),
  status: IssueStatusSchema,
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1),
  classification: RuleClassificationSchema,
  rule: z.object({ id: z.string().min(1) }),
  principles: z.array(z.string()).optional(),
  target: FindingTargetSchema,
  evidence: z.array(EvidenceSchema),
  message: z.string().min(1),
  proposal: z.string().optional(),
  acceptance: z.array(z.string()).optional(),
  detectedAt: z.string(),
  updatedAt: z.string(),
  /** Present only when a human accepted the deviation. */
  acceptedReason: z.string().optional(),
  history: z.array(IssueEventSchema).optional(),
  /** Trackers this issue has been exported to. See IssueExportSchema. */
  exports: z.array(IssueExportSchema).optional(),
  /** Cases made for accepting this, awaiting or having had a human decision. */
  proposals: z.array(IssueProposalSchema).optional(),
  /** Agents' reports that this is fixed. Input to verification, not a result. */
  claims: z.array(IssueClaimSchema).optional(),
  /** Every verification run against this issue, passed or failed. */
  verifications: z.array(VerificationSchema).optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

/**
 * Movement across a run. Reported instead of an opaque total score.
 *
 * There is deliberately no `resolved` count. Only the verifier may resolve an
 * issue, and the verifier arrives with runtime checking — until then, the most
 * that can honestly be said about a finding that stopped appearing is that it
 * stopped appearing.
 */
export interface IssueCounts {
  total: number;
  /** Issues allocated a new `UX-` number in this run. */
  introduced: number;
  /** Open issues re-detected in this run. */
  stillOpen: number;
  /** Issues a human chose to live with. */
  accepted: number;
  /** On record, but no rule reported them this run. */
  noLongerDetected: number;
}
