import { z } from "zod";
import { severityRank, type Finding, type Issue } from "@drumlin/model";
import type { Engine, IssuePacket } from "@drumlin/engine";

/**
 * The four tools, and nothing else.
 *
 * Read-only by construction. There is no `submit_candidate_resolution`, no
 * `record_decision`, no `verify_issue`, and no shell — the last is an explicit
 * prohibition in Context/14, and the rest wait for Milestone C's verifier.
 *
 * The reasoning is the same in every case: an agent that can close its own
 * issue has been handed the grading pen. `accepted` stays a human CLI action,
 * and `resolved` stays something only a verifier can assert.
 *
 * Output is prose rather than JSON. An agent reads a paragraph better than it
 * reads a nested object, and every field here exists to be acted on.
 */

/** The tool surface, asserted by a test so it cannot grow by accident. */
export const TOOL_NAMES = [
  "drumlin_project_summary",
  "drumlin_get_flow",
  "drumlin_get_issue",
  "drumlin_check_changed",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolContext {
  engine: Engine;
  /** The workspace every tool operates on. Never taken from the agent. */
  root: string;
  app?: string;
  /**
   * Uncommitted files, for `drumlin_check_changed`.
   *
   * A function rather than a value because the server is long-lived and the
   * working tree moves under it: resolving this once at startup would answer
   * every later call with the state of the repository when Cursor opened.
   */
  changedFiles?: () => Promise<string[]>;
}

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  run(context: ToolContext, input: Record<string, unknown>): Promise<string>;
}

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const TOOL_ANNOTATIONS = READ_ONLY;

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "drumlin_project_summary",
    title: "What Drumlin understands about this app",
    description:
      "Orientation for the current workspace: screens, entry points, route sections, " +
      "and how many UX issues are open by severity. Call this before making structural " +
      "changes so you are not guessing at the shape of the app.",
    inputSchema: {},
    async run(context) {
      const summary = await context.engine.request("project.summary", {
        root: context.root,
        ...appOf(context),
      });

      const lines = [
        `${summary.root} — Next.js ${summary.router} router`,
        `${summary.counts.screens} screens, ${summary.counts.states} states, ` +
          `${summary.counts.actions} actions, ${summary.counts.components} components, ` +
          `${summary.counts.edges} graph edges`,
      ];

      if (summary.sections.length > 0) {
        lines.push(
          "",
          "Sections:",
          ...summary.sections.map(
            (section) => `  ${section.prefix}  ${section.screens} screens`,
          ),
        );
      }

      if (summary.entryPoints.length > 0) {
        lines.push("", `Entry points: ${summary.entryPoints.join(", ")}`);
      }

      if (summary.roles) {
        lines.push(`Confirmed roles: ${summary.roles.join(", ")}`);
      } else {
        lines.push(
          "",
          "No confirmed role model, so nothing here knows who is allowed where.",
        );
      }

      lines.push("", issueSummary(summary.issues));

      if (!summary.persisted) {
        lines.push(
          "",
          "This workspace has no .drumlin/ directory, so issue IDs are not stable " +
            "across runs. `drumlin init` fixes that.",
        );
      }

      return lines.join("\n");
    },
  },

  {
    name: "drumlin_get_flow",
    title: "The graph neighbourhood of a route",
    description:
      "What links into a route, what it links out to, which loading/error/not-found " +
      "states cover it, and which actions it offers. Read this before changing " +
      "navigation: inbound links live in whatever imports the screen, which is the " +
      "one thing reading the file itself cannot tell you.",
    inputSchema: {
      route: z
        .string()
        .describe(
          "A route such as /invoices/[id], a concrete URL such as /invoices/42, " +
            "or a screen node id from a finding.",
        ),
    },
    async run(context, input) {
      const flow = await context.engine.request("graph.flow", {
        root: context.root,
        ...appOf(context),
        route: String(input["route"] ?? ""),
      });

      const screen = flow.screen;
      const lines = [
        `${screen.route ?? screen.id} (${screen.id})`,
        `  file: ${screen.sources?.[0]?.file ?? "unknown"}`,
      ];

      lines.push("", `Reached from (${flow.inbound.length}):`);
      if (flow.inbound.length === 0) {
        lines.push(
          "  nothing — no screen in the app links here, so a user can only arrive by typing the URL",
        );
      } else {
        for (const link of flow.inbound.slice(0, 25)) {
          lines.push(`  ${link.route}${describeLink(link)}`);
        }
      }

      lines.push("", `Leads to (${flow.outbound.length}):`);
      if (flow.outbound.length === 0) {
        lines.push("  nothing — this is a dead end apart from global navigation");
      } else {
        for (const link of flow.outbound.slice(0, 25)) {
          lines.push(`  ${link.route}${describeLink(link)}`);
        }
      }

      lines.push(
        "",
        flow.states.length === 0
          ? "States: none declared. No loading, error, or not-found boundary covers this screen."
          : `States: ${flow.states
              .map(
                (state) =>
                  `${state.kind}${state.inherited ? " (inherited)" : ""}`,
              )
              .join(", ")}`,
      );

      if (flow.actions.length > 0) {
        lines.push(
          `Actions: ${flow.actions
            .map(
              (action) =>
                `${action.label}${action.destructive ? " (destructive)" : ""}`,
            )
            .join(", ")}`,
        );
      }

      if (flow.issues.length > 0) {
        lines.push("", "Open issues here:");
        for (const issue of flow.issues) {
          lines.push(`  ${issue.id} [${issue.severity}] ${issue.message}`);
        }
      }

      return lines.join("\n");
    },
  },

  {
    name: "drumlin_get_issue",
    title: "The full packet for one UX issue",
    description:
      "Everything needed to fix a single issue: what is wrong, what it should be " +
      "instead, the acceptance criteria, the evidence, the surrounding graph, which " +
      "files to start in, and the command that re-tests it. Call this instead of " +
      "guessing from a finding's one-line message.",
    inputSchema: {
      id: z.string().describe("An issue id such as UX-7."),
    },
    async run(context, input) {
      const result = await context.engine.request("issue.get", {
        root: context.root,
        ...appOf(context),
        id: String(input["id"] ?? ""),
      });
      return renderPacket(result.packet);
    },
  },

  {
    name: "drumlin_check_changed",
    title: "UX findings in what changed",
    description:
      "Re-checks the workspace and reports only findings attributable to uncommitted " +
      "files, or to files that import them. Use it after editing to see what your " +
      "changes broke. The analysis always covers the whole graph — reachability is " +
      "global, so a screen can be orphaned by an edit three directories away — and " +
      "this narrows what you are shown, not what was examined.",
    inputSchema: {
      severity: z
        .enum(["info", "low", "medium", "high", "critical"])
        .optional()
        .describe("Only report findings at this severity or above."),
    },
    async run(context, input) {
      const changed = (await context.changedFiles?.()) ?? [];

      const run = await context.engine.request("check.run", {
        root: context.root,
        ...appOf(context),
        ...(changed.length > 0 ? { changed } : {}),
      });

      const threshold = input["severity"]
        ? severityRank(input["severity"] as Finding["severity"])
        : 0;
      const findings = run.findings
        .filter((finding) => severityRank(finding.severity) >= threshold)
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity));

      const scope = run.attribution
        ? `${run.attribution.changedFiles.length} changed file(s), ` +
          `${run.attribution.coneSize} file(s) affected, ` +
          `${run.attribution.totalFindings} finding(s) in the whole app`
        : "no changed files known, so this is the whole app";

      if (findings.length === 0) {
        return `No findings. Scope: ${scope}.`;
      }

      const lines = [`${findings.length} finding(s). Scope: ${scope}.`, ""];

      for (const finding of findings.slice(0, 25)) {
        const issue = matchIssue(run.issues, finding);
        lines.push(
          `${issue ? `${issue.id} ` : ""}[${finding.severity}] ${finding.message}`,
        );
        lines.push(`  rule: ${finding.ruleId}`);
        if (finding.proposal) lines.push(`  fix: ${finding.proposal}`);
        const located = finding.evidence.find((item) => item.location?.file);
        if (located?.location) {
          const { file, line } = located.location;
          lines.push(`  at: ${file}${line ? `:${line}` : ""}`);
        }
        if (issue) {
          lines.push(`  packet: call drumlin_get_issue with id ${issue.id}`);
        }
        lines.push("");
      }

      if (findings.length > 25) {
        lines.push(`${findings.length - 25} more not shown.`);
      }

      return lines.join("\n").trimEnd();
    },
  },
];

function appOf(context: ToolContext): { app?: string } {
  return context.app ? { app: context.app } : {};
}

function issueSummary(issues: {
  total: number;
  open: number;
  accepted: number;
  bySeverity: Record<string, number>;
}): string {
  if (issues.total === 0) return "No issues on record yet. Run `drumlin check`.";

  const bySeverity = Object.entries(issues.bySeverity)
    .filter(([, count]) => count > 0)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");

  return (
    `${issues.open} open issue(s)${bySeverity ? `: ${bySeverity}` : ""}` +
    (issues.accepted > 0
      ? `. ${issues.accepted} accepted as intentional deviations.`
      : ".")
  );
}

function describeLink(link: {
  kind?: string;
  chrome?: boolean;
  preserve?: boolean;
  file?: string;
  line?: number;
}): string {
  const notes: string[] = [];
  if (link.kind) notes.push(link.kind);
  if (link.chrome) notes.push("global nav");
  if (link.preserve) notes.push("carries search params");
  if (link.file) notes.push(`${link.file}${link.line ? `:${link.line}` : ""}`);
  return notes.length > 0 ? `  — ${notes.join(", ")}` : "";
}

function matchIssue(
  issues: readonly Issue[],
  finding: Finding,
): Issue | undefined {
  return issues.find(
    (issue) =>
      issue.rule.id === finding.ruleId &&
      issue.target.node === finding.target.node &&
      issue.target.from === finding.target.from &&
      issue.target.to === finding.target.to &&
      issue.target.route === finding.target.route,
  );
}

function renderPacket(packet: IssuePacket): string {
  const issue = packet.issue;
  const lines = [
    `${issue.id} [${issue.severity}] ${issue.status}`,
    "",
    `Problem: ${packet.currentBehaviour}`,
  ];

  if (packet.targetBehaviour) lines.push(`Should be: ${packet.targetBehaviour}`);
  if (packet.actor) lines.push(`Affects: ${packet.actor}`);

  lines.push(
    "",
    "Done when:",
    ...packet.acceptance.map((item) => `  - ${item}`),
  );

  if (packet.constraints.length > 0) {
    lines.push(
      "",
      "Constraints:",
      ...packet.constraints.map((item) => `  - ${item}`),
    );
  }

  if (packet.likelyFiles.length > 0) {
    lines.push(
      "",
      "Start in:",
      ...packet.likelyFiles.slice(0, 8).map((file) => `  ${file}`),
    );
  }

  if (issue.evidence.length > 0) {
    lines.push("", "Evidence:");
    for (const evidence of issue.evidence.slice(0, 10)) {
      const where = evidence.location
        ? `${evidence.location.file}${evidence.location.line ? `:${evidence.location.line}` : ""}`
        : (evidence.ref ?? evidence.type);
      lines.push(`  ${where}${evidence.note ? ` — ${evidence.note}` : ""}`);
    }
  }

  const flow = packet.neighbourhood;
  if (flow) {
    lines.push(
      "",
      `Around ${flow.screen.route ?? flow.screen.id}:`,
      `  reached from: ${
        flow.inbound.length === 0
          ? "nothing"
          : flow.inbound
              .slice(0, 8)
              .map((link) => link.route)
              .join(", ")
      }`,
      `  leads to: ${
        flow.outbound.length === 0
          ? "nothing"
          : flow.outbound
              .slice(0, 8)
              .map((link) => link.route)
              .join(", ")
      }`,
      `  states: ${
        flow.states.length === 0
          ? "none"
          : flow.states.map((state) => state.kind).join(", ")
      }`,
    );
  }

  if (packet.primitives.length > 0) {
    lines.push(
      "",
      `Design-system components already in this codebase: ${packet.primitives.join(", ")}.`,
      "Use these rather than writing new ones.",
    );
  }

  lines.push("", `Re-test with: ${packet.retestCommand}`);

  if (issue.status === "accepted") {
    lines.push(
      "",
      "A human accepted this deviation. Do not change it without asking them.",
    );
  } else {
    const pending = (issue.proposals ?? []).find(
      (proposal) => proposal.state === "pending",
    );

    lines.push(
      "",
      "Drumlin cannot close this issue on your word — only a verifier can, and " +
        "there is no verifier yet.",
    );

    if (pending) {
      lines.push(
        `A proposal to accept it is already awaiting a human decision: "${pending.reason}"`,
      );
    } else {
      // Told explicitly, because the alternative is an agent that believes a
      // finding is wrong and has nowhere to say so. That agent works around
      // the finding instead, which is worse than an argument on the record.
      lines.push(
        "If you think the current behaviour is correct, make the case with " +
          "`drumlin propose <id> --reason \"...\"`. That records your reasoning " +
          "on the issue for a person to decide. Running `drumlin accept` " +
          "yourself will be refused: it is a human decision, and Drumlin " +
          "checks who is asking.",
      );
    }
  }

  return lines.join("\n");
}
