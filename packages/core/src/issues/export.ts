import type { Issue, Severity } from "@drumlin/model";

/**
 * Handing issues to the tracker the team actually plans in.
 *
 * Drumlin is not a project management tool and should not try to become one. A
 * `UX-` id is useful because it is stable and because it survives reruns, not
 * because `.drumlin/issues/` is where anyone wants to do standup.
 *
 * Both formats here are files rather than API calls, which is a deliberate
 * limit and not a shortcut. Pushing over an API needs a token, which needs
 * somewhere to keep a token, and Local-First Default says machine-local means
 * machine-local. A file the developer reads before importing also means Drumlin
 * cannot create fifty tickets in a shared workspace because a rule misfired.
 */

export const EXPORT_TARGETS = ["linear", "github", "markdown"] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

export interface ExportOptions {
  /** Repository-relative label for the app, used in the issue body. */
  app?: string;
}

/**
 * Linear's CSV import.
 *
 * Columns are the documented set its CLI importer reads: Title, Description,
 * Priority, Status, Assignee, Created, Completed, Labels, Estimate. Comma
 * delimited — Linear's importer had a semicolon bug, fixed in @linear/import
 * 1.10.2, and comma is what its own export produces.
 */
const LINEAR_COLUMNS = [
  "Title",
  "Description",
  "Priority",
  "Status",
  "Assignee",
  "Created",
  "Completed",
  "Labels",
  "Estimate",
] as const;

/** Linear priority is 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
const LINEAR_PRIORITY: Record<Severity, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
  info: 0,
};

export function toLinearCsv(
  issues: readonly Issue[],
  options: ExportOptions = {},
): string {
  const rows = [LINEAR_COLUMNS.join(",")];

  for (const issue of issues) {
    rows.push(
      [
        title(issue),
        body(issue, options),
        String(LINEAR_PRIORITY[issue.severity]),
        linearStatus(issue),
        "",
        issue.detectedAt,
        // Only a verifier sets `resolved`, so this is the one honest source for
        // a completion timestamp.
        issue.status === "resolved" ? issue.updatedAt : "",
        labels(issue).join(","),
        "",
      ]
        .map(csvField)
        .join(","),
    );
  }

  return `${rows.join("\n")}\n`;
}

/**
 * GitHub has no CSV import, so this is a script rather than a data file.
 *
 * `gh issue create` per issue, with bodies in quoted heredocs so nothing in a
 * finding message can be expanded by the shell. Labels are created first with
 * `|| true`, because `gh issue create --label` fails outright on a label the
 * repository does not have, which would otherwise abort the run halfway.
 *
 * Emitted for review, not piped into `sh`. The developer reads it, then runs
 * it.
 */
export function toGithubScript(
  issues: readonly Issue[],
  options: ExportOptions = {},
): string {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "#",
    "# Drumlin UX issues, as `gh issue create` calls.",
    "#",
    `# ${issues.length} issue(s). Read this before running it: every line`,
    "# creates a real issue in the repository `gh` is pointed at.",
    "#",
    "#   gh repo set-default <owner/repo>   # if it is not already",
    "#   bash this-file.sh",
    "",
    "set -euo pipefail",
    "",
  ];

  const allLabels = new Set<string>();
  for (const issue of issues) for (const label of labels(issue)) allLabels.add(label);

  if (allLabels.size > 0) {
    lines.push("# Labels first: `--label` on a label that does not exist is a hard error.");
    for (const label of [...allLabels].sort()) {
      lines.push(`gh label create ${shellQuote(label)} --force >/dev/null 2>&1 || true`);
    }
    lines.push("");
  }

  for (const issue of issues) {
    const marker = `DRUMLIN_${issue.id.replace(/-/g, "_")}`;
    lines.push(
      `gh issue create \\`,
      `  --title ${shellQuote(title(issue))} \\`,
      `  --label ${shellQuote(labels(issue).join(","))} \\`,
      `  --body "$(cat <<'${marker}'`,
      body(issue, options),
      marker,
      `)"`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

/** Plain markdown, for pasting somewhere neither formatter fits. */
export function toMarkdown(
  issues: readonly Issue[],
  options: ExportOptions = {},
): string {
  const blocks = issues.map(
    (issue) => `## ${title(issue)}\n\n${body(issue, options)}`,
  );
  return `${blocks.join("\n\n---\n\n")}\n`;
}

/**
 * The `UX-` id leads the title on purpose.
 *
 * It is the only thing that makes the exported issue findable from Drumlin's
 * side, and the only way a human spots a duplicate after a second import.
 */
function title(issue: Issue): string {
  return `[${issue.id}] ${firstSentence(issue.message)}`;
}

function body(issue: Issue, options: ExportOptions): string {
  const lines: string[] = [issue.message, ""];

  if (issue.proposal) {
    lines.push("**Proposed fix**", "", issue.proposal, "");
  }

  if (issue.acceptance && issue.acceptance.length > 0) {
    lines.push("**Done when**", "");
    for (const item of issue.acceptance) lines.push(`- [ ] ${item}`);
    lines.push("");
  }

  // Files only. Graph node ids like `screen.invoices.id` are how Drumlin
  // refers to things internally and mean nothing to somebody reading a ticket
  // in Linear, where the useful question is which file to open.
  const where = [
    ...new Set(
      issue.evidence
        .map((item) => item.location?.file)
        .filter((file): file is string => typeof file === "string" && file.length > 0),
    ),
  ];

  if (where.length > 0) {
    lines.push("**Where**", "");
    for (const file of where) lines.push(`- \`${file}\``);
    lines.push("");
  }

  if (issue.status === "accepted") {
    lines.push(
      "**Accepted as intentional**",
      "",
      issue.acceptedReason ?? acceptNote(issue) ?? "No reason recorded.",
      "",
    );
  }

  lines.push(
    "---",
    "",
    `Found by Drumlin rule \`${issue.rule.id}\` · severity ${issue.severity} · confidence ${issue.confidence}`,
    "",
    "Re-test with:",
    "",
    "```",
    `drumlin check${options.app ? ` --app ${options.app}` : ""} --rule ${issue.rule.id}`,
    "```",
    "",
    // Said plainly because a tracker is where this issue will be read, and the
    // reader needs to know that ticking it closed in Linear does not close it
    // here. Only the verifier does that.
    `Closing this in your tracker does not close \`${issue.id}\` in Drumlin.`,
  );

  return lines.join("\n");
}

function labels(issue: Issue): string[] {
  return ["drumlin", `ux:${issue.severity}`, issue.rule.id];
}

/**
 * Drumlin status to a Linear workflow state.
 *
 * `accepted` maps to Cancelled rather than Done: a deviation somebody decided
 * to live with was never worked, and filing it as completed would overstate
 * what happened.
 */
function linearStatus(issue: Issue): string {
  switch (issue.status) {
    case "resolved":
      return "Done";
    case "accepted":
    case "superseded":
      return "Cancelled";
    case "in_progress":
    case "assigned":
    case "candidate_resolved":
    case "verifying":
      return "In Progress";
    default:
      return "Todo";
  }
}

function acceptNote(issue: Issue): string | undefined {
  return [...(issue.history ?? [])]
    .reverse()
    .find((event) => event.to === "accepted")?.note;
}

function firstSentence(message: string): string {
  const cut = message.indexOf(", so ");
  const trimmed = cut === -1 ? message : message.slice(0, cut);
  return trimmed.replace(/\.$/, "");
}

/** RFC 4180: quote everything, double the quotes. */
function csvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
