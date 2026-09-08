import { classifyCaller } from "@drumlin/model";
import { outcomeSummary } from "@drumlin/core";
import type { IssueVerifyReport } from "@drumlin/engine";
import {
  flagBoolean,
  flagString,
  outputFormat,
  type ParsedArgs,
} from "../args.js";
import { dim } from "../format/outline.js";
import type { Engine } from "@drumlin/engine";

/**
 * `drumlin claim` — say you fixed something, and get checked.
 *
 * The counterpart to `drumlin accept` being human-only, and the reason that
 * restriction is liveable. An agent that has genuinely fixed a finding needs
 * somewhere to put that, and the answer is not the accept path: accepting says
 * *this is fine as it is*, which is a judgement, while claiming says *this is
 * no longer true*, which is a testable assertion.
 *
 * So this is deliberately unguarded. No caller classification, no TTY, no
 * confirmation — an agent should find this easy, because everything it says
 * here gets checked before it counts for anything.
 */
export async function claimCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const [id] = args.positional;
  const note = flagString(args, "note") ?? flagString(args, "reason");

  if (!id || !note) {
    process.stderr.write(
      `Usage: drumlin claim <UX-id> --note "what you changed"\n\n` +
        `Asks the verifier to check a fix. It does not close anything.\n`,
    );
    return 1;
  }

  const caller = classifyCaller({
    interactive: process.stdin.isTTY === true,
    env: process.env,
  });

  // Verifying by default. A claim nobody checks is just a comment, and the
  // whole value of the claim is the check it triggers.
  const verify = flagBoolean(args, "verify", true);

  const result = await engine.request("issue.claim", {
    root: cwd,
    ...appFlag(args),
    id,
    note,
    by: caller.actor,
    verify,
    ...sessionOf(),
  });

  if (outputFormat(args) === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const issue = result.issue;
  process.stdout.write(
    `Claim recorded on ${issue.id}, by ${caller.actor}.\n` +
      dim(`  "${note}"\n\n`),
  );

  if (!result.verification) {
    process.stdout.write(
      `${issue.id} is ${issue.status}, awaiting verification.\n` +
        dim(`  Run \`drumlin verify ${issue.id}\` to have it checked.\n`),
    );
    return 0;
  }

  process.stdout.write(render([reportOf(result.verification, issue)]));
  // Exit non-zero when the claim did not hold. An agent that ran this as its
  // last step should be able to tell from the exit code that it is not done.
  return result.verification.outcome === "gone" ? 0 : 1;
}

/**
 * `drumlin verify` — the only path to `resolved`.
 *
 * Re-derives everything from source with the cache off and compares against
 * the issue's own fingerprint. It does not read the claim. That is the point:
 * an agent's account of what it changed is a hint about what to look at, and
 * this command does not need the hint because it looks at everything.
 */
export async function verifyCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const [id] = args.positional;

  const result = await engine.request("issue.verify", {
    root: cwd,
    ...appFlag(args),
    ...(id ? { id } : {}),
  });

  if (outputFormat(args) === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (result.verified.length === 0) {
    process.stdout.write(
      id
        ? `Nothing to verify for ${id}.\n`
        : `No claimed fixes waiting to be verified.\n` +
            dim(
              `  An agent records one with \`drumlin claim <UX-id> --note "..."\`.\n`,
            ),
    );
    return 0;
  }

  process.stdout.write(render(result.verified));
  return result.verified.every((entry) => entry.outcome === "gone") ? 0 : 1;
}

function render(reports: readonly IssueVerifyReport[]): string {
  const lines: string[] = [];

  for (const report of reports) {
    lines.push(`${report.id}  ${report.summary}`);
    for (const line of report.evidence) lines.push(dim(`    ${line}`));

    if (report.outcome === "gone") {
      lines.push(dim(`    now ${report.status}`));
    } else {
      // Saying where it is left, because the useful thing to know after a
      // failed verification is that nothing moved and it is still on the list.
      lines.push(dim(`    left as ${report.status}`));
    }
    lines.push("");
  }

  const resolved = reports.filter((r) => r.outcome === "gone").length;
  if (resolved !== reports.length) {
    lines.push(
      dim(
        `${resolved} of ${reports.length} verified. ` +
          `Unverified issues stay open — Drumlin not being able to prove a fix ` +
          `is not the same as the fix being wrong.\n`,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Shape a single verification like the report `issue.verify` would produce. */
function reportOf(
  verification: { outcome: IssueVerifyReport["outcome"]; evidence: string[] },
  issue: { id: string; status: IssueVerifyReport["status"] },
): IssueVerifyReport {
  return {
    id: issue.id,
    outcome: verification.outcome,
    status: issue.status,
    summary: outcomeSummary(verification.outcome),
    evidence: verification.evidence,
  };
}

function sessionOf(): { session?: string } {
  const session =
    process.env["DRUMLIN_SESSION"] ?? process.env["CURSOR_CONVERSATION_ID"];
  return session ? { session } : {};
}

function appFlag(args: ParsedArgs): { app?: string } {
  const app = flagString(args, "app");
  return app ? { app } : {};
}
