import { createInterface } from "node:readline/promises";
import { classifyCaller, type Issue, type IssueProposal } from "@drumlin/model";
import { flagString, outputFormat, type ParsedArgs } from "../args.js";
import { dim } from "../format/outline.js";
import type { Engine } from "@drumlin/engine";

/**
 * `drumlin accept` — recording an intentional deviation.
 *
 * The only way to make Drumlin stop reporting something, so Context/11 gives
 * it to a person. Milestone B kept it off the MCP surface and called that
 * enough. It was not: the agent in an editor has a shell, so it could run this
 * command, and the CLI wrote `by: "human"` for whoever ran it. The first
 * dogfooding session accepted a real finding in a real repository that way,
 * with a plausible reason, attributed to a human who had not been asked.
 *
 * Two changes fix it. This command now classifies its caller and refuses
 * anything that does not look like a person at a terminal, and it runs against
 * a local in-process engine because the daemon refuses `issue.accept` — a
 * check for "is a human doing this" is worthless in a process that has no
 * terminal to check.
 *
 * `classifyCaller` is honest about being defeatable. What makes this hold in
 * practice is that the refusal is the default path and the write is a
 * committed diff.
 */
export async function acceptCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const [id] = args.positional;
  if (!id) {
    process.stderr.write(
      `Usage: drumlin accept <UX-id> --reason "why this is intentional"\n`,
    );
    return 1;
  }

  const caller = classifyCaller({
    interactive: process.stdin.isTTY === true,
    env: process.env,
  });

  if (!caller.mayDecide) {
    process.stderr.write(
      `Refusing to accept ${id}.\n\n` +
        `  ${caller.refusal}\n\n` +
        dim(`  observed: ${caller.evidence.join("; ")}\n`),
    );
    return 1;
  }

  const issue = await load(engine, args, cwd, id);
  if (!issue) {
    process.stderr.write(`No issue ${id}. Run \`drumlin check\` to see what exists.\n`);
    return 1;
  }

  const pending = pendingProposal(issue);
  const reason = flagString(args, "reason") ?? pending?.proposal.reason;

  if (!reason) {
    process.stderr.write(
      `An accept needs --reason. Six months from now it is the only thing\n` +
        `that will tell an intentional deviation from a rule that misfired.\n`,
    );
    return 1;
  }

  // Shown before the confirmation, not after, because the point of the pause is
  // to read what is about to be silenced.
  process.stdout.write(
    `\n${issue.id}  ${issue.severity}  ${issue.message}\n` +
      dim(`  rule ${issue.rule.id}\n`),
  );

  if (pending) {
    process.stdout.write(
      `\n  ${pending.proposal.by} proposed accepting this:\n` +
        `    "${pending.proposal.reason}"\n`,
    );
  }

  process.stdout.write(`\n  reason: ${reason}\n\n`);

  if (!(await confirm(issue))) {
    process.stdout.write("Left alone.\n");
    return 1;
  }

  const result = await engine.request("issue.accept", {
    root: cwd,
    ...appFlag(args),
    id,
    reason,
    // What made us believe a person is here. Recorded on the issue so a later
    // reader can judge the accept, not just see it.
    attestation: [...caller.evidence, "confirmed at an interactive prompt"],
    ...(pending ? { grants: pending.index } : {}),
  });

  if (outputFormat(args) === "json") {
    process.stdout.write(`${JSON.stringify(result.issue, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${result.issue.id} accepted\n` +
      dim(
        `  It stays on record and stays out of the report. ` +
          `\`drumlin check --accepted\` still shows it.\n`,
      ),
  );
  return 0;
}

/**
 * `drumlin revoke` — the way back out.
 *
 * Missing from the first version of this, which in hindsight is the more
 * serious half of the same mistake. Everything above is about making an
 * acceptance hard to obtain, and none of it matters if a wrong one is
 * permanent. The forged acceptance that motivated the caller check was still
 * sitting in a real repository afterwards, silencing a real finding, because
 * no command could reverse it.
 *
 * Lighter than `accept`: no terminal check, no typed confirmation. Accepting
 * removes a finding from the report and revoking puts one back, and only the
 * first of those can hide a real problem. What revoking keeps is the ownership
 * check, because it lands the issue in `confirmed` — a status that asserts
 * somebody with standing thinks this is real. An agent does not get to make
 * that assertion about a decision a person recorded, so the engine turns it
 * down. Agents argue with `propose` instead.
 */
export async function revokeCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const [id] = args.positional;

  // No id lists what is currently silenced, because an accepted finding is by
  // construction one nothing reminds you about.
  if (!id) return listAccepted(engine, args, cwd);

  const reason = flagString(args, "reason");
  if (!reason) {
    process.stderr.write(
      `A revoke needs --reason. It overturns a decision somebody recorded,\n` +
        `and the history keeps both sides.\n\n` +
        `Usage: drumlin revoke <UX-id> --reason "why the acceptance no longer holds"\n`,
    );
    return 1;
  }

  const caller = classifyCaller({
    interactive: process.stdin.isTTY === true,
    env: process.env,
  });

  const result = await engine.request("issue.revoke", {
    root: cwd,
    ...appFlag(args),
    id,
    reason,
    by: caller.actor,
  });

  if (outputFormat(args) === "json") {
    process.stdout.write(`${JSON.stringify(result.issue, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `${result.issue.id} is ${result.issue.status} again, and reported again.\n`,
  );

  if (result.wasAcceptedFor) {
    process.stdout.write(
      dim(`  was accepted for: "${result.wasAcceptedFor}"\n`) +
        dim(`  revoked because:  "${reason}"\n`),
    );
  }

  if (!result.wasAttested) {
    process.stdout.write(
      `\n  That acceptance carried no attestation.\n` +
        dim(
          `  It was recorded as a human decision with nothing establishing one.\n`,
        ),
    );
  }

  process.stdout.write(dim("\n  Both decisions stay in the issue history.\n"));
  return 0;
}

/**
 * What is currently silenced, and how well each acceptance is evidenced.
 *
 * `attested: false` means the record says a human decided without recording
 * anything that established it — either an acceptance predating the caller
 * check, or one that came from something other than a person.
 */
async function listAccepted(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const { accepted } = await engine.request("issues.accepted", {
    root: cwd,
    ...appFlag(args),
  });

  if (outputFormat(args) === "json") {
    process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
    return 0;
  }

  if (accepted.length === 0) {
    process.stdout.write("Nothing is accepted here.\n");
    return 0;
  }

  const unattested = accepted.filter((entry) => !entry.attested);

  process.stdout.write(
    `${accepted.length} accepted, so not reported:\n\n`,
  );

  for (const entry of accepted) {
    process.stdout.write(
      `  ${entry.id}  ${entry.message}\n` +
        dim(`    ${entry.reason ?? "no reason recorded"}\n`) +
        dim(
          `    ${entry.rule} · ${entry.at ?? "date unknown"}` +
            `${entry.attested ? "" : " · no attestation"}\n\n`,
        ),
    );
  }

  if (unattested.length > 0) {
    process.stdout.write(
      `${unattested.length} of these carry no attestation: ` +
        `${unattested.map((entry) => entry.id).join(", ")}\n` +
        dim(
          `  Recorded as human decisions with nothing establishing one. ` +
            `Worth a look.\n`,
        ),
    );
  }

  process.stdout.write(
    dim(`\nPut one back with \`drumlin revoke <id> --reason "..."\`.\n`),
  );
  return 0;
}

/**
 * `drumlin propose` — the agent's path.
 *
 * Deliberately available to an agent, and deliberately unable to change
 * anything. An agent that has just read the code is often right that a finding
 * is a false positive, and the failure mode of giving it nowhere to say so is
 * worse than the failure mode of letting it argue: it either works around the
 * finding or complains in a chat log nobody keeps.
 */
export async function proposeCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const [id] = args.positional;
  const reason = flagString(args, "reason");

  if (!id || !reason) {
    process.stderr.write(
      `Usage: drumlin propose <UX-id> --reason "why this finding is wrong or acceptable"\n\n` +
        `Records the case for accepting. A person decides; this changes nothing.\n`,
    );
    return 1;
  }

  const caller = classifyCaller({
    interactive: process.stdin.isTTY === true,
    env: process.env,
  });

  const result = await engine.request("issue.propose", {
    root: cwd,
    ...appFlag(args),
    id,
    reason,
    by: caller.actor,
    ...sessionOf(),
  });

  if (outputFormat(args) === "json") {
    process.stdout.write(`${JSON.stringify(result.issue, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `Proposal recorded on ${result.issue.id}, by ${caller.actor}.\n` +
      dim(`  "${reason}"\n\n`) +
      `${result.issue.id} is still ${result.issue.status} and still reported.\n` +
      dim(
        `  A person decides with \`drumlin accept ${result.issue.id}\`, ` +
          `or turns it down with \`drumlin decline ${result.issue.id}\`.\n`,
      ),
  );
  return 0;
}

/** `drumlin decline` — turn down a proposal without accepting it. */
export async function declineCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const [id] = args.positional;
  if (!id) {
    process.stderr.write("Usage: drumlin decline <UX-id> [--reason \"why not\"]\n");
    return 1;
  }

  const note = flagString(args, "reason");
  const result = await engine.request("issue.decline", {
    root: cwd,
    ...appFlag(args),
    id,
    ...(note ? { note } : {}),
  });

  if (result.declined === 0) {
    process.stdout.write(`${result.issue.id} has no proposal awaiting a decision.\n`);
    return 0;
  }

  process.stdout.write(
    `Declined ${result.declined} proposal(s) on ${result.issue.id}.\n` +
      dim("  The issue stays open and stays reported.\n"),
  );
  return 0;
}

/**
 * The pause, and the strongest check here.
 *
 * Typing the issue id rather than pressing y, because the id is on screen next
 * to the message it belongs to, and copying it means having looked at it.
 *
 * There is deliberately no `--yes`. It was written and then removed: the env
 * and tty checks in `classifyCaller` are both defeatable by an agent that
 * clears its own environment and allocates a pseudo-terminal, and testing that
 * showed `--yes` was the difference between "defeatable in principle" and
 * "defeatable in one command". Having to read runtime output and answer it is
 * the part that does not fall to a wrapper script. Worse, `--yes` made the
 * recorded attestation claim a confirmation that never happened, which is more
 * damaging than recording nothing at all.
 *
 * The cost is typing an id per accept. Accepting is meant to be deliberate,
 * and the reason is already mandatory per issue, so there was never a batch
 * flow to protect.
 */
async function confirm(issue: Issue): Promise<boolean> {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await readline.question(
      `Type ${issue.id} to accept it, or anything else to stop: `,
    );
    return answer.trim().toUpperCase() === issue.id.toUpperCase();
  } finally {
    readline.close();
  }
}

async function load(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
  id: string,
): Promise<Issue | undefined> {
  const { issues } = await engine.request("issues.list", {
    root: cwd,
    ...appFlag(args),
  });
  const wanted = id.trim().toUpperCase();
  return issues.find(
    (issue) =>
      issue.id.toUpperCase() === wanted ||
      issue.id.replace(/^UX-0*/, "") === wanted.replace(/^UX-0*/, ""),
  );
}

function pendingProposal(
  issue: Issue,
): { proposal: IssueProposal; index: number } | undefined {
  const index = (issue.proposals ?? []).findIndex(
    (proposal) => proposal.state === "pending",
  );
  if (index === -1) return undefined;
  return { proposal: issue.proposals![index]!, index };
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
