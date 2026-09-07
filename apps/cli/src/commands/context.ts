import { relative } from "node:path";
import { flagBoolean, flagString, outputFormat, type ParsedArgs } from "../args.js";
import { dim } from "../format/outline.js";
import type { Engine } from "@drumlin/engine";

/**
 * `drumlin context` — propose a role and permission model.
 *
 * Prints what it believes and, more importantly, what it cannot determine.
 * Nothing about roles is ever reported as a finding until the model is
 * confirmed, because a guessed permission model is worse than none: it produces
 * confident, specific, wrong claims about who can see what.
 */
export async function contextCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const format = outputFormat(args);
  const root = flagString(args, "app") ?? flagString(args, "root") ?? cwd;

  const result = await engine.request("context.infer", {
    root,
    write: flagBoolean(args, "write", false),
    confirm: flagBoolean(args, "confirm", false),
  });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const lines: string[] = [];
  lines.push(`Drumlin context — ${relative(cwd, root) || "."}`);

  const roles = result.beliefs.filter((belief) => belief.subject === "role");
  const capabilities = result.beliefs.filter(
    (belief) => belief.subject === "capability",
  );
  const groups = result.beliefs.filter(
    (belief) => belief.subject === "role group",
  );

  if (roles.length > 0) {
    lines.push("");
    lines.push("Roles I believe exist:");
    for (const belief of roles) {
      lines.push(
        `  ${belief.statement.padEnd(18)} ${dim(
          `${belief.confidence.toFixed(2)}  ${belief.detail ?? ""}`,
        )}`,
      );
    }
  }

  if (groups.length > 0) {
    lines.push("");
    lines.push("Role groups:");
    for (const belief of groups) lines.push(`  ${belief.statement}`);
  }

  if (capabilities.length > 0) {
    lines.push("");
    lines.push("Capability flags (may be roles, may be permissions):");
    for (const belief of capabilities) {
      lines.push(
        `  ${belief.statement.padEnd(18)} ${dim(
          `${belief.confidence.toFixed(2)}  ${belief.detail ?? ""}`,
        )}`,
      );
    }
  }

  if (result.uncertainties.length > 0) {
    lines.push("");
    lines.push("What I cannot determine from the repository:");
    for (const uncertainty of result.uncertainties) {
      lines.push("");
      lines.push(`  ${uncertainty.subject}`);
      lines.push(`    ${uncertainty.question}`);
      if (uncertainty.candidates && uncertainty.candidates.length > 0) {
        lines.push(`    ${dim(uncertainty.candidates.join(", "))}`);
      }
    }
  }

  if (roles.length === 0 && capabilities.length === 0) {
    lines.push("");
    lines.push(
      "No role model found. If this app has one, it is expressed in a way I do not recognise —",
    );
    lines.push(
      "write .drumlin/context/permissions.yaml by hand and I will use it as given.",
    );
  }

  lines.push("");
  if (result.written) {
    lines.push(
      `Wrote ${relative(cwd, result.written)}${
        result.confirmed
          ? " as confirmed (provenance: human)."
          : " as a proposal (provenance: inferred)."
      }`,
    );
    if (!result.confirmed) {
      lines.push(
        dim(
          "Review it, then re-run with --confirm to record it as confirmed. Permission rules stay off until then.",
        ),
      );
    }
  } else {
    lines.push(
      dim(
        "Nothing written. Use --write to save this as a proposal, or --confirm to record it as confirmed.",
      ),
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
