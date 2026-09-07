import { relative } from "node:path";
import { severityRank, type Severity } from "@drumlin/model";
import {
  flagBoolean,
  flagString,
  outputFormat,
  type ParsedArgs,
} from "../args.js";
import { dim } from "../format/outline.js";
import {
  renderByRule,
  renderCounts,
  renderFindings,
  type FindingLine,
} from "../format/findings.js";
import { findingFingerprint } from "@drumlin/model";
import { changedFiles, isGitRepository } from "@drumlin/repo";
import type { Engine } from "@drumlin/engine";

/**
 * How many renames to list before summarising. Enough to see a real rename in
 * a normal commit; a number larger than this usually means a refactor moved
 * everything, and listing forty lines helps nobody.
 */
const RENAMES_SHOWN = 5;

/**
 * `drumlin check` — report UX findings.
 *
 * Exit code is 0 unless `--fail-on` is given. A tool that fails a developer's
 * build on its first run, before its precision has been established, gets
 * removed from the build.
 */
export async function checkCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const format = outputFormat(args);
  const root = flagString(args, "app") ?? flagString(args, "root") ?? cwd;
  const rulesFlag = flagString(args, "rule") ?? flagString(args, "rules");

  const changed = resolveChanged(args, root);
  const observed = flagString(args, "observed");

  const result = await engine.request("check.run", {
    root,
    cache: flagBoolean(args, "cache", true),
    ...(rulesFlag ? { rules: rulesFlag.split(",").map((id) => id.trim()) } : {}),
    ...(changed ? { changed } : {}),
    ...(observed ? { observed } : {}),
  });

  const minSeverity = flagString(args, "severity") as Severity | undefined;
  const threshold = minSeverity ? severityRank(minSeverity) : -1;

  const issueByFingerprint = new Map(
    result.issues.map((issue) => [issue.fingerprint, issue]),
  );

  const showAccepted = flagBoolean(args, "accepted", false);

  const withIssues: FindingLine[] = result.findings.map((finding) => {
    const issue = issueByFingerprint.get(findingFingerprint(finding));
    return issue ? { finding, issue } : { finding };
  });

  const entries: FindingLine[] = withIssues
    .filter((entry) => severityRank(entry.finding.severity) >= threshold)
    .filter((entry) => showAccepted || entry.issue?.status !== "accepted");

  const limitFlag = flagString(args, "limit");
  const limit = limitFlag ? Number.parseInt(limitFlag, 10) : entries.length;
  const shown = entries.slice(0, Math.max(0, limit));

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          findings: shown.map((entry) => ({
            ...entry.finding,
            issueId: entry.issue?.id,
            status: entry.issue?.status,
          })),
          counts: result.counts,
          stats: result.stats,
          ruleErrors: result.ruleErrors,
        },
        null,
        2,
      )}\n`,
    );
    return exitCodeFor(args, shown.map((entry) => entry.finding.severity));
  }

  const lines: string[] = [];
  lines.push(
    `Drumlin check — ${relative(cwd, result.graph.workspace?.root ?? root) || "."}`,
  );
  lines.push(
    dim(
      `${result.stats.screens} screens · ${result.stats.actions} actions · ${
        result.graph.edges.length
      } edges${result.cached ? " (cached)" : ` (${result.stats.durationMs}ms)`}`,
    ),
  );
  lines.push(dim(renderCounts(result.counts)));

  // Deduplication happens before attribution, so it has to be credited against
  // the pre-scope count. Comparing it to the final number reads as
  // "14 reduced to 0 by deduplication" on a run where dedup did nothing and
  // scoping did all the work.
  const deduped = result.attribution?.totalFindings ?? result.findings.length;
  if (result.rawFindingCount !== deduped) {
    lines.push(
      dim(
        `${result.rawFindingCount} raw findings reduced to ${deduped} by deduplication`,
      ),
    );
  }

  if (result.attribution) {
    const { changedFiles, coneSize, totalFindings } = result.attribution;
    lines.push(
      dim(
        changedFiles.length === 0
          ? "--changed matched no source files, so nothing is attributable"
          : `--changed · ${changedFiles.length} file(s) changed, ${coneSize} affected · ` +
              `${result.findings.length} of ${totalFindings} findings attributable`,
      ),
    );
    // Worth saying out loud, because DEC-0002 originally promised the opposite
    // and someone reading this output will want to know which one happened.
    lines.push(dim("(every rule ran over the whole graph; only the report is scoped)"));
  }
  // Retargeting has to be visible. It rewrites what an issue points at, so
  // that a `UX-` number survives a rename — and a number that quietly changes
  // meaning is worse than one that is lost, because nothing prompts you to
  // look. If the resolver got a match wrong, this line is the only place it
  // shows up before the issue does.
  const renames = result.renames;
  if (renames && renames.renamed.length > 0) {
    lines.push(
      dim(
        `${renames.renamed.length} node(s) look renamed · ` +
          `${renames.retargeted.length} issue(s) followed`,
      ),
    );
    for (const entry of renames.renamed.slice(0, RENAMES_SHOWN)) {
      lines.push(
        dim(
          `  ${entry.from} → ${entry.to} ` +
            `(${entry.because.join(", ")}, ${entry.score.toFixed(2)})`,
        ),
      );
    }
    if (renames.renamed.length > RENAMES_SHOWN) {
      lines.push(
        dim(`  … ${renames.renamed.length - RENAMES_SHOWN} more`),
      );
    }
  }
  // Ambiguity is reported but never acted on, so it is the case where a number
  // does go missing. Saying which node it happened to is the difference
  // between a fixable report and "accepting findings randomly stops working".
  if (renames && renames.ambiguous.length > 0) {
    lines.push(
      dim(
        `${renames.ambiguous.length} node(s) too close to call, left as new: ` +
          renames.ambiguous.join(", "),
      ),
    );
  }

  if (!result.persisted) {
    lines.push(
      dim("not persisted — run `drumlin init` to keep issue IDs across runs"),
    );
  }

  lines.push("");
  if (shown.length > 0 || entries.length === 0) {
    lines.push(
      renderFindings(shown, {
        total: withIssues.length,
        ...(minSeverity ? { severity: minSeverity } : {}),
        accepted: showAccepted
          ? 0
          : withIssues.filter((entry) => entry.issue?.status === "accepted")
              .length,
      }),
    );
  }

  if (entries.length > shown.length) {
    lines.push("");
    lines.push(dim(`… ${entries.length - shown.length} more (raise --limit)`));
  }

  if (shown.length > 0) {
    lines.push("");
    lines.push("By rule:");
    lines.push(renderByRule(shown.map((entry) => entry.finding)));
  }

  for (const error of result.ruleErrors) {
    lines.push("");
    lines.push(`rule ${error.ruleId} failed: ${error.message}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return exitCodeFor(args, shown.map((entry) => entry.finding.severity));
}

/**
 * What `--changed` means.
 *
 * Bare, it is the working tree: staged, unstaged, and untracked, which is what
 * "what have I touched" means while editing. Given a value, it is a revision to
 * compare against — `--changed main` before opening a pull request.
 *
 * Returns undefined when the flag is absent, which is different from returning
 * an empty array: no flag means report everything, while a flag that found
 * nothing means report nothing.
 */
function resolveChanged(
  args: ParsedArgs,
  root: string,
): string[] | undefined {
  const value = args.flags.get("changed");
  if (value === undefined || value === false) return undefined;

  // Said out loud, because the alternative is a silent empty report. Outside a
  // repository `--changed` has no way to know what moved, and answering "no
  // findings" to that question is the one behaviour this tool cannot afford:
  // it is indistinguishable from a clean app.
  if (!isGitRepository(root)) {
    process.stderr.write(
      "--changed needs Git to know what moved, and this is not a working tree.\n" +
        "Reporting everything instead.\n\n",
    );
    return undefined;
  }

  const since = typeof value === "string" ? value : undefined;
  return changedFiles({ root, ...(since ? { since } : {}) });
}

/**
 * Exit non-zero only when explicitly asked.
 *
 * `--fail-on high` is opt-in so the tool can be trusted in a build once its
 * precision is known, rather than before.
 */
function exitCodeFor(args: ParsedArgs, severities: readonly Severity[]): number {
  const failOn = flagString(args, "fail-on") as Severity | undefined;
  if (!failOn) return 0;
  const threshold = severityRank(failOn);
  return severities.some((severity) => severityRank(severity) >= threshold)
    ? 1
    : 0;
}
