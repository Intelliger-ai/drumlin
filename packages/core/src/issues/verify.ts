import { findingFingerprint } from "@drumlin/model";
import type {
  Finding,
  GraphDocument,
  Issue,
  NodeId,
  Verification,
  VerificationOutcome,
} from "@drumlin/model";

/**
 * Deciding whether an issue is actually fixed.
 *
 * The whole point of this module is that it does not take the fixer's word for
 * anything. An agent's claim arrives as `claim` and is carried into the record
 * for context, but it is never an input to the decision — the decision is made
 * by re-deriving from source and looking at what came back.
 *
 * See vault/Loop/Verification Ownership.md.
 */

export interface VerifyInput {
  issue: Issue;
  /** Every finding from a fresh run. Not filtered, not scoped, not cached. */
  findings: readonly Finding[];
  /**
   * Rules that actually executed and did not throw.
   *
   * Passed in rather than inferred from `findings`, because a rule that
   * produced nothing and a rule that never ran look identical from the output
   * side — and the first is the normal state of healthy code. Guessing from
   * output meant the cleaner a codebase got, the less Drumlin could verify.
   */
  rulesRun: readonly string[];
  /** The graph that run produced, to tell a fix from a deletion. */
  graph: GraphDocument;
  now: string;
  /** The claim being tested, if a claim prompted this. */
  claim?: string;
}

/**
 * Whether the finding is gone, and whether that means anything.
 *
 * Four outcomes rather than a boolean, because "the rule no longer fires" has
 * more than one cause and they do not deserve the same conclusion:
 *
 * - `present` — it still fires. Nothing was fixed.
 * - `gone` — it stopped firing, and the thing it was about still exists. This
 *   is the only outcome that resolves an issue.
 * - `vanished` — it stopped firing because its subject is gone. Deleting the
 *   screen would produce this, and so would fixing it by removing the feature.
 *   Indistinguishable from here, so it resolves nothing and asks a person.
 * - `inconclusive` — the run could not speak to it, usually because the rule
 *   did not execute. Silence from a rule that did not run is not evidence.
 */
export function verifyIssue(input: VerifyInput): Verification {
  const { issue, findings, graph, now } = input;
  const evidence: string[] = [];

  const stillFires = findings.some(
    (finding) => findingFingerprint(finding) === issue.fingerprint,
  );

  // Did the rule that raised this actually run? A rule that was disabled,
  // errored, or was filtered out reports nothing, which looks exactly like a
  // clean pass. Treating that as a pass would let a disabled rule resolve every
  // issue it used to raise.
  const ruleRan = input.rulesRun.includes(issue.rule.id);

  const node = issue.target.node;
  const subjectExists = node === undefined || hasNode(graph, node);

  if (stillFires) {
    evidence.push(
      `${issue.rule.id} fired again with the same fingerprint (${short(issue.fingerprint)})`,
    );
    return record("present", evidence, input);
  }

  if (!subjectExists) {
    evidence.push(
      `${issue.rule.id} no longer fires, but ${node} is not in the graph either`,
    );
    evidence.push(
      "cannot distinguish a fix from a deletion, so this is not a resolution",
    );
    return record("vanished", evidence, input);
  }

  if (!ruleRan) {
    evidence.push(
      `${issue.rule.id} did not run — it is disabled in config, or it threw`,
    );
    evidence.push("silence from a rule that never executed is not a pass");
    return record("inconclusive", evidence, input);
  }

  evidence.push(
    `${issue.rule.id} ran and no longer reports ${short(issue.fingerprint)}`,
  );
  if (node) evidence.push(`${node} is still in the graph`);
  // Said out loud in the record, because someone reading this in six months
  // needs to know what class of proof they are looking at.
  evidence.push(
    "static check only: the rule stopped matching the source, which is not the same as the experience being verified",
  );
  return record("gone", evidence, input);
}

function record(
  outcome: VerificationOutcome,
  evidence: string[],
  input: VerifyInput,
): Verification {
  const verification: Verification = {
    at: input.now,
    kind: "static",
    outcome,
    by: "verifier",
    evidence,
  };
  if (input.claim) verification.claim = input.claim;
  return verification;
}

/**
 * The status an outcome justifies, or nothing.
 *
 * Only `gone` moves an issue, and only to `resolved`. `vanished` and
 * `inconclusive` leave it exactly where it was, which is the conservative
 * choice and the correct one: an issue that stays open because Drumlin could
 * not prove a fix costs somebody a second look, while an issue wrongly closed
 * costs a user the bug.
 */
export function outcomeStatus(
  outcome: VerificationOutcome,
): "resolved" | undefined {
  return outcome === "gone" ? "resolved" : undefined;
}

/** Why an outcome did not resolve, for showing the person who asked. */
export function outcomeSummary(outcome: VerificationOutcome): string {
  switch (outcome) {
    case "gone":
      return "verified — the rule no longer reports it and its subject still exists";
    case "present":
      return "not fixed — the rule still reports it";
    case "vanished":
      return "cannot verify — the screen or component it was about is gone, so a fix and a deletion look identical";
    case "inconclusive":
      return "cannot verify — the rule that raised it does not appear to have run";
  }
}

function hasNode(graph: GraphDocument, id: NodeId): boolean {
  return graph.nodes.some((node) => node.id === id);
}

function short(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}
