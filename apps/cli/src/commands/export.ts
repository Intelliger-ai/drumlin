import { writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  EXPORT_TARGETS,
  toGithubScript,
  toLinearCsv,
  toMarkdown,
  type ExportTarget,
} from "@drumlin/core";
import { flagBoolean, flagString, type ParsedArgs } from "../args.js";
import { dim } from "../format/outline.js";
import type { Engine } from "@drumlin/engine";

/**
 * `drumlin export` — hand the issue list to the tracker the team plans in.
 *
 * Drumlin owns whether a UX problem is real. It should not also try to own
 * sprint planning, and `.drumlin/issues/` is a terrible backlog. So this emits
 * a file for Linear or GitHub and gets out of the way.
 *
 * A file rather than an API push, deliberately: no token to store, and nothing
 * that can create forty tickets in a shared workspace because a rule misfired.
 * The developer reads the file first.
 */
export async function exportCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const target = (flagString(args, "to") ??
    flagString(args, "format") ??
    "linear") as ExportTarget;

  if (!EXPORT_TARGETS.includes(target)) {
    process.stderr.write(
      `Unknown export target ${target}. Expected one of: ${EXPORT_TARGETS.join(", ")}.\n`,
    );
    return 1;
  }

  const out = flagString(args, "out");
  // Nothing is marked as exported unless it is actually going somewhere the
  // developer can act on. Previewing to a terminal must not consume the
  // "already exported" state that `--new` depends on.
  const record = flagBoolean(args, "record", out !== undefined);

  const result = await engine.request("issues.export", {
    root: cwd,
    ...appFlag(args),
    target,
    onlyNew: flagBoolean(args, "new", false),
    includeAccepted: flagBoolean(args, "accepted", false),
    includeClosed: flagBoolean(args, "closed", false),
    record,
  });

  if (result.issues.length === 0) {
    process.stdout.write(`${nothingToExport(result.skipped, args)}\n`);
    return 0;
  }

  const options = { ...appFlag(args) };
  const body =
    target === "linear"
      ? toLinearCsv(result.issues, options)
      : target === "github"
        ? toGithubScript(result.issues, options)
        : toMarkdown(result.issues, options);

  if (!out) {
    process.stdout.write(body);
    return 0;
  }

  const file = resolve(cwd, out);
  writeFileSync(file, body, "utf8");

  const lines = [
    `${result.issues.length} issue(s) written to ${relative(cwd, file) || out}`,
  ];

  if (target === "linear") {
    lines.push(
      dim("  Import in Linear: Settings → Import/Export → CLI import → Linear CSV"),
    );
  }
  if (target === "github") {
    lines.push(dim("  Read it, then: bash " + (relative(cwd, file) || out)));
    lines.push(dim("  It calls `gh issue create` once per issue."));
  }

  const noted = Object.entries(result.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${SKIP_LABEL[reason] ?? reason}`);
  if (noted.length > 0) lines.push(dim(`  skipped ${noted.join(", ")}`));

  if (result.recorded) {
    lines.push(
      dim(
        "  Recorded against each issue, so `--new` will skip them next time.",
      ),
    );
  }

  // The one thing a tracker cannot represent, said before anyone assumes
  // otherwise: Drumlin's own state machine is unaffected by what happens over
  // there. Only the verifier closes a UX- id.
  lines.push("");
  lines.push(
    dim("Closing these in your tracker does not close them in Drumlin."),
  );

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

const SKIP_LABEL: Record<string, string> = {
  alreadyExported: "already exported",
  accepted: "accepted (use --accepted)",
  closed: "resolved or superseded (use --closed)",
};

function nothingToExport(
  skipped: { alreadyExported: number; accepted: number; closed: number },
  args: ParsedArgs,
): string {
  const total = skipped.alreadyExported + skipped.accepted + skipped.closed;
  if (total === 0) {
    return "No issues to export. Run `drumlin check` first, in a project with `.drumlin/`.";
  }
  if (skipped.alreadyExported > 0 && flagBoolean(args, "new", false)) {
    return `Nothing new. All ${skipped.alreadyExported} issue(s) have already been exported to this target.`;
  }
  return `No issues matched. ${total} were filtered out — try --accepted or --closed.`;
}

function appFlag(args: ParsedArgs): { app?: string } {
  const app = flagString(args, "app");
  return app ? { app } : {};
}
