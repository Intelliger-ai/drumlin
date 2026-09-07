import type { Actor } from "./issues.js";

/**
 * Deciding whether the thing running Drumlin is a person.
 *
 * `accepted` is the one status that makes a finding go away, so Context/11
 * gives it to a human and the MCP surface does not expose it. That reasoning
 * had a hole in it: the CLI stamped `by: "human"` on whoever ran the command,
 * and in an editor like Cursor the agent has a shell. An agent could silence
 * its own finding to finish a turn, and the record would say a person decided
 * it. The first dogfooding run did exactly that by accident.
 *
 * ## What this can and cannot do
 *
 * There is no way to prove humanness from inside a process the agent controls.
 * An agent that allocates a pseudo-terminal and clears its own environment
 * markers will pass every check below. That is worth stating plainly rather
 * than implying a guarantee that does not exist.
 *
 * What these checks do buy:
 *
 * 1. **The default path fails.** An agent doing the obvious thing — running
 *    `drumlin accept` in its shell — is refused and told to propose instead.
 *    Silencing a finding stops being the path of least resistance.
 * 2. **The conclusion is recorded.** Every accept carries the evidence that
 *    led to `human`, so an accept with thin evidence is visible later.
 * 3. **The write is reviewable.** Acceptance lands in a committed file, so a
 *    forged one still shows up in `git diff` before it reaches anyone else.
 *
 * Defence in depth, in other words, rather than a lock. The lock does not
 * exist; pretending otherwise is how you get trusted for the wrong reason.
 */

/**
 * Variables set by coding agents in the shells they run commands in.
 *
 * Presence means "an agent is driving", not "an agent is malicious" — most of
 * these exist so tools can be helpful about it.
 */
const AGENT_MARKERS = [
  "CURSOR_AGENT",
  "CURSOR_CONVERSATION_ID",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "AIDER_CHAT",
  "OPENAI_CODEX",
  "CODEX_SANDBOX",
  "REPLIT_AGENT",
  "DRUMLIN_AGENT",
] as const;

/** Non-interactive automation. Not an agent, equally not a person. */
const AUTOMATION_MARKERS = [
  "CI",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
] as const;

export interface CallerSignals {
  /** Whether stdin is an interactive terminal. */
  interactive: boolean;
  env: Record<string, string | undefined>;
}

export interface CallerVerdict {
  /** Who we believe is running this. */
  actor: Actor;
  /** Whether this caller may make a decision reserved for a person. */
  mayDecide: boolean;
  /** What led to the conclusion. Recorded on the issue. */
  evidence: string[];
  /** Why a refusal happened, in words the caller can act on. */
  refusal?: string;
}

export function classifyCaller(signals: CallerSignals): CallerVerdict {
  const agent = present(AGENT_MARKERS, signals.env);
  if (agent.length > 0) {
    return {
      actor: "agent",
      mayDecide: false,
      evidence: [`agent environment (${agent.join(", ")})`],
      refusal:
        "This looks like an agent shell, and accepting a finding is a human " +
        "decision. Use `drumlin propose` to make the case instead; a person " +
        "then decides.",
    };
  }

  const automation = present(AUTOMATION_MARKERS, signals.env);
  if (automation.length > 0) {
    return {
      actor: "agent",
      mayDecide: false,
      evidence: [`automation environment (${automation.join(", ")})`],
      refusal:
        "This looks like CI. An accept is a judgement about the product that " +
        "should be made by a person and land in a reviewed commit, not by a " +
        "build. Run it locally, or edit the issue file in a pull request.",
    };
  }

  if (!signals.interactive) {
    return {
      actor: "agent",
      mayDecide: false,
      evidence: ["stdin is not a terminal"],
      refusal:
        "Accepting a finding needs an interactive terminal, so that a person " +
        "can confirm it. Run this in your own shell, without piping input.",
    };
  }

  return {
    actor: "human",
    mayDecide: true,
    evidence: ["interactive terminal", "no agent or CI markers in environment"],
  };
}

function present(
  names: readonly string[],
  env: Record<string, string | undefined>,
): string[] {
  return names.filter((name) => {
    const value = env[name];
    return value !== undefined && value !== "" && value !== "0" && value !== "false";
  });
}
