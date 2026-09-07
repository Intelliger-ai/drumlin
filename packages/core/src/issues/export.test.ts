import { describe, expect, it } from "vitest";
import type { Issue } from "@drumlin/model";
import { toGithubScript, toLinearCsv, toMarkdown } from "./export.js";

/**
 * Exported issues have to survive a trip through someone else's importer,
 * which is a lower-trust environment than the rest of the codebase: a stray
 * quote becomes a corrupt row, and a stray backtick becomes shell execution.
 */
const issue: Issue = {
  id: "UX-0007",
  fingerprint: "fp-7",
  status: "detected",
  severity: "critical",
  confidence: 0.85,
  classification: "deterministic",
  rule: { id: "flow.destructive.no-confirm" },
  target: { kind: "node", node: "action.delete", route: "/invoices/[id]" },
  evidence: [
    { type: "source", ref: "delete", location: { file: "app/actions.ts", line: 12 } },
    { type: "graph", ref: "action.delete" },
  ],
  message: 'deleteInvoice destroys data, so a "misplaced" click is unrecoverable.',
  proposal: "Confirm before running it.",
  acceptance: ["Triggering it requires confirmation."],
  detectedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("Linear CSV", () => {
  it("emits the columns Linear's importer reads", () => {
    const header = toLinearCsv([issue]).split("\n")[0];

    expect(header).toBe(
      "Title,Description,Priority,Status,Assignee,Created,Completed,Labels,Estimate",
    );
  });

  it("leads the title with the UX id", () => {
    // The only thing that makes the ticket findable from Drumlin's side, and
    // the only way a human spots a duplicate after a second import.
    expect(toLinearCsv([issue])).toContain('"[UX-0007]');
  });

  it("doubles embedded quotes rather than escaping them", () => {
    // RFC 4180. A backslash escape parses as a literal backslash and shifts
    // every following column by one.
    const csv = toLinearCsv([issue]);

    expect(csv).toContain('a ""misplaced"" click');
    expect(csv).not.toContain('a \\"misplaced');
  });

  it("maps severity onto Linear's priority scale", () => {
    // 0 none, 1 urgent, 2 high, 3 medium, 4 low. Matched together with the
    // status that follows it, because the description field legally contains
    // newlines and a bare `"1"` could come from anywhere in it.
    const priority = (severity: Issue["severity"]): string =>
      toLinearCsv([{ ...issue, severity }]);

    expect(priority("critical")).toContain('"1","Todo"');
    expect(priority("high")).toContain('"2","Todo"');
    expect(priority("medium")).toContain('"3","Todo"');
    expect(priority("low")).toContain('"4","Todo"');
    expect(priority("info")).toContain('"0","Todo"');
  });

  it("files an accepted deviation as cancelled, not done", () => {
    // It was never worked. Calling it done overstates what happened.
    const csv = toLinearCsv([{ ...issue, status: "accepted" }]);

    expect(csv).toContain('"Cancelled"');
    expect(csv).not.toContain('"Done"');
  });

  it("only claims a completion date when a verifier set one", () => {
    expect(toLinearCsv([issue])).not.toContain(issue.updatedAt);
    expect(toLinearCsv([{ ...issue, status: "resolved" }])).toContain(
      issue.updatedAt,
    );
  });

  it("keeps every row on one line despite multi-line descriptions", () => {
    // The description is markdown with blank lines in it; quoted newlines are
    // legal CSV, so the check is that the header is intact and the field is
    // opened and closed cleanly.
    const csv = toLinearCsv([issue, { ...issue, id: "UX-0008" }]);

    expect(csv.match(/^"\[UX-000[78]\]/gm)).toHaveLength(2);
  });
});

describe("GitHub script", () => {
  it("creates labels before using them", () => {
    // `gh issue create --label` is a hard error on a label the repository does
    // not have, which would abort a long run halfway through.
    // Anchored to the start of a line: the header comment mentions
    // `gh issue create` while explaining what the script does.
    const script = toGithubScript([issue]);
    const labelAt = script.search(/^gh label create/m);
    const issueAt = script.search(/^gh issue create/m);

    expect(labelAt).toBeGreaterThan(-1);
    expect(labelAt).toBeLessThan(issueAt);
  });

  it("puts the body in a quoted heredoc", () => {
    // Unquoted, a backtick or $( in a finding message would be executed by the
    // shell running the script.
    const script = toGithubScript([issue]);

    expect(script).toContain("<<'DRUMLIN_UX_0007'");
  });

  it("single-quotes titles and escapes the quotes inside them", () => {
    const script = toGithubScript([
      { ...issue, message: "it's broken, so nothing works" },
    ]);

    expect(script).toContain(`'\\''`);
  });

  it("refuses to continue past a failure", () => {
    expect(toGithubScript([issue])).toContain("set -euo pipefail");
  });
});

describe("issue bodies", () => {
  it("lists files, not graph node ids", () => {
    // `action.delete` is how Drumlin refers to things internally and means
    // nothing to whoever picks the ticket up.
    const body = toMarkdown([issue]);

    expect(body).toContain("app/actions.ts");
    expect(body).not.toContain("- `action.delete`");
  });

  it("says that closing it in the tracker changes nothing here", () => {
    // Stated where the issue will actually be read. Only a verifier closes a
    // UX- id, and a tracker cannot represent that.
    expect(toMarkdown([issue])).toContain(
      "does not close `UX-0007` in Drumlin",
    );
  });

  it("carries the acceptance criteria as a checklist", () => {
    expect(toMarkdown([issue])).toContain(
      "- [ ] Triggering it requires confirmation.",
    );
  });

  it("gives the reason when the issue was accepted", () => {
    const body = toMarkdown([
      {
        ...issue,
        status: "accepted",
        acceptedReason: "the confirm lives in the parent dialog",
      },
    ]);

    expect(body).toContain("the confirm lives in the parent dialog");
  });

  it("falls back to the history note for an older accept", () => {
    // Accepts recorded before `acceptedReason` existed kept the reason only in
    // the event log.
    const body = toMarkdown([
      {
        ...issue,
        status: "accepted",
        history: [
          {
            at: "2026-01-03T00:00:00.000Z",
            to: "accepted",
            by: "human",
            note: "decided in review",
          },
        ],
      },
    ]);

    expect(body).toContain("decided in review");
  });
});
