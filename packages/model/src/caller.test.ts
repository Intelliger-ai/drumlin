import { describe, expect, it } from "vitest";
import { classifyCaller } from "./caller.js";

/**
 * The check that decides whether `by: "human"` may be written.
 *
 * These tests exist because the original code had no check at all: the CLI
 * wrote `by: "human"` for whoever ran the command, and in Cursor that is
 * routinely an agent. A real finding in a real repository was silenced that
 * way, attributed to a person who was never asked.
 */
describe("classifyCaller", () => {
  const human = { interactive: true, env: {} };

  it("believes a terminal with nothing suspicious in the environment", () => {
    const verdict = classifyCaller(human);

    expect(verdict.actor).toBe("human");
    expect(verdict.mayDecide).toBe(true);
    expect(verdict.refusal).toBeUndefined();
    expect(verdict.evidence).toContain("interactive terminal");
  });

  it("refuses an agent shell even when it has a terminal", () => {
    const verdict = classifyCaller({
      interactive: true,
      env: { CURSOR_AGENT: "1" },
    });

    expect(verdict.actor).toBe("agent");
    expect(verdict.mayDecide).toBe(false);
    expect(verdict.refusal).toContain("drumlin propose");
    // Named, so the refusal explains itself rather than being mysterious.
    expect(verdict.evidence.join(" ")).toContain("CURSOR_AGENT");
  });

  it("refuses a caller with no terminal to confirm at", () => {
    const verdict = classifyCaller({ interactive: false, env: {} });

    expect(verdict.mayDecide).toBe(false);
    expect(verdict.evidence).toContain("stdin is not a terminal");
  });

  it("refuses CI, and for a different reason than it refuses an agent", () => {
    const verdict = classifyCaller({
      interactive: true,
      env: { CI: "true" },
    });

    expect(verdict.mayDecide).toBe(false);
    expect(verdict.refusal).toContain("reviewed commit");
    expect(verdict.refusal).not.toContain("drumlin propose");
  });

  it("recognises the agents that are actually likely to run this", () => {
    for (const marker of [
      "CURSOR_AGENT",
      "CURSOR_CONVERSATION_ID",
      "CLAUDECODE",
      "OPENAI_CODEX",
      "REPLIT_AGENT",
    ]) {
      expect(
        classifyCaller({ interactive: true, env: { [marker]: "1" } }).mayDecide,
        `${marker} should block a human-only decision`,
      ).toBe(false);
    }
  });

  it("does not treat an unset or falsy marker as an agent", () => {
    // Env vars arrive as strings, so a literal "false" or "0" would otherwise
    // read as present and lock a real person out of their own accept.
    for (const value of ["", "0", "false"]) {
      expect(
        classifyCaller({ interactive: true, env: { CI: value } }).mayDecide,
        `CI=${JSON.stringify(value)} should not block`,
      ).toBe(true);
    }

    expect(
      classifyCaller({ interactive: true, env: { CI: undefined } }).mayDecide,
    ).toBe(true);
  });

  it("reports agent markers ahead of the terminal check", () => {
    // Both are true here. The agent explanation is the useful one, because it
    // comes with somewhere else to go.
    const verdict = classifyCaller({
      interactive: false,
      env: { CURSOR_AGENT: "1" },
    });

    expect(verdict.refusal).toContain("drumlin propose");
  });
});
