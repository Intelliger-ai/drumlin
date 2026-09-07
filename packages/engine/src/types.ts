import type {
  Actor,
  Finding,
  GraphDocument,
  GraphNode,
  Issue,
  IssueCounts,
  IssueStatus,
  Provenance,
  Severity,
  Verification,
  VerificationOutcome,
} from "@drumlin/model";
import type { BrokenLink, IndexStats, NextApp } from "@drumlin/indexer";

/**
 * The engine surface, shaped as a request/response protocol.
 *
 * There is no daemon in Milestone A — this runs in-process. The interface uses
 * the wire method names anyway so that extracting `drumlind` later is a
 * transport change rather than a redesign, which is the whole point of
 * DEC-0002. Every command goes through here; nothing calls the indexer
 * directly.
 */

export interface WorkspaceOpenParams {
  root: string;
  /** Explicit app root, for monorepos with more than one Next.js app. */
  app?: string;
}

export interface WorkspaceOpenResult {
  app: NextApp;
}

export interface GraphGetParams extends WorkspaceOpenParams {
  /** Bypass the derived cache and re-index from source. */
  cache?: boolean;
}

export interface GraphGetResult {
  graph: GraphDocument;
  stats: IndexStats;
  brokenLinks: BrokenLink[];
  /** True when the IR was served from the derived cache. */
  cached: boolean;
}

export interface CheckRunParams extends GraphGetParams {
  /** Restrict the run to these rule IDs. */
  rules?: string[];
  /**
   * Report only findings attributable to these files or their dependents.
   *
   * Scopes the *report*, never the analysis. Reachability is a whole-graph
   * property — an orphan is created by the absence of a link somewhere else
   * entirely — so narrowing the rule run to a dependency cone would silently
   * stop half the rules from firing. See DEC-0003.
   */
  changed?: string[];
  /**
   * Path to a recorded browser observation, to diff against the source.
   *
   * Folded into the same run rather than given its own command, so runtime
   * findings pass through the same reconcile, get the same `UX-` numbers, and
   * can be accepted and exported like everything else. A separate pipeline
   * would need its own copy of all of that, and would mean a runtime problem
   * and a static one about the same screen never met.
   */
  observed?: string;
}

export interface CheckRunResult {
  findings: Finding[];
  issues: Issue[];
  counts: IssueCounts;
  graph: GraphDocument;
  stats: IndexStats;
  cached: boolean;
  /** Findings removed by deduplication. Reported to keep dedup inspectable. */
  suppressed: number;
  rawFindingCount: number;
  /** Rules that threw. A broken rule degrades the run, never fails it. */
  ruleErrors: Array<{ ruleId: string; message: string }>;
  /** False when `.drumlin/` is absent, so nothing was written. */
  persisted: boolean;
  /** Set when `changed` was given: how the report was narrowed. */
  attribution?: AttributionSummary;
  /** Set when the graph moved under an issue: what was renamed and retargeted. */
  renames?: RenameReport;
}

export interface AttributionSummary {
  /** Files the caller said changed, after filtering to analyzable sources. */
  changedFiles: string[];
  /** Those files plus everything importing them, transitively. */
  coneSize: number;
  /** Findings the whole-graph run produced before scoping the report. */
  totalFindings: number;
}

export interface ContextInferParams extends GraphGetParams {
  /** Write the proposal to `.drumlin/context/`, marked as inferred. */
  write?: boolean;
  /**
   * Record the proposal as confirmed by a human.
   *
   * Separate from `write` on purpose: writing a file is not the same as a
   * person having checked it, and only the latter may claim human provenance.
   */
  confirm?: boolean;
}

/** Something Drumlin thinks is true, with how sure it is and why. */
export interface Belief {
  subject: string;
  statement: string;
  confidence: number;
  provenance: Provenance;
  /** How the belief was arrived at, in a few words. */
  detail?: string;
}

/** Something Drumlin cannot determine from the repository alone. */
export interface Uncertainty {
  subject: string;
  question: string;
  /** Options worth presenting, when there is a shortlist. */
  candidates?: string[];
}

export interface ContextInferResult {
  beliefs: Belief[];
  uncertainties: Uncertainty[];
  /** Path written, when `write` or `confirm` was requested. */
  written?: string;
  /** True when the written document claims human provenance. */
  confirmed?: boolean;
}

export interface IssuesListParams extends WorkspaceOpenParams {
  status?: string[];
}

export interface IssuesListResult {
  issues: Issue[];
}

export interface WorkspaceStatusParams extends WorkspaceOpenParams {}

export interface WorkspaceStatusResult {
  root: string;
  app: NextApp;
  /** True when a daemon is holding parsed sources for this workspace. */
  warm: boolean;
  /**
   * Advances on every rebuild.
   *
   * The point of exposing it is that a stale warm graph is indistinguishable
   * from a rule bug, which DEC-0002 already flagged for the cache. A client
   * that can see the revision and the pending-file count can tell the
   * difference without re-indexing to find out.
   */
  revision: number;
  indexedAt?: string;
  /** Changed files not yet folded into the graph. */
  pendingFiles: number;
  /** Whether `.drumlin/` exists, so whether issue IDs persist. */
  persisted: boolean;
  daemonPid?: number;
}

export interface GraphFlowParams extends GraphGetParams {
  /** A route such as `/invoices/[id]`, or a screen node ID. */
  route: string;
}

/** One end of a transition, flattened for reading. */
export interface FlowLink {
  route: string;
  node: string;
  kind?: string;
  chrome?: boolean;
  /** Whether the link forwards the current search params. */
  preserve?: boolean;
  file?: string;
  line?: number;
}

export interface GraphFlowResult {
  screen: GraphNode;
  /** Screens that link here. Empty means nothing navigates to it. */
  inbound: FlowLink[];
  outbound: FlowLink[];
  /** Loading, error, and not-found boundaries covering this screen. */
  states: Array<{ node: string; kind: string; inherited: boolean }>;
  actions: Array<{ node: string; label: string; destructive: boolean }>;
  /** Open issues whose target is this screen. */
  issues: Issue[];
}

export interface ProjectSummaryParams extends GraphGetParams {}

export interface ProjectSummaryResult {
  root: string;
  router: "app" | "pages" | "mixed";
  counts: {
    screens: number;
    states: number;
    actions: number;
    components: number;
    edges: number;
  };
  /** Where a user can arrive from outside the app. */
  entryPoints: string[];
  /** Route prefixes with more than one screen, largest first. */
  sections: Array<{ prefix: string; screens: number }>;
  issues: {
    total: number;
    open: number;
    accepted: number;
    bySeverity: Record<Severity, number>;
  };
  /** Confirmed roles, when a human has signed off on a permissions model. */
  roles?: string[];
  persisted: boolean;
}

export interface IssueGetParams extends GraphGetParams {
  /** A `UX-` identifier. */
  id: string;
}

/**
 * Everything an agent needs to fix one issue without asking a follow-up.
 *
 * The field list comes from Context/11 and Context/12. Milestone B fills what
 * the repository can prove and omits the rest — `actor` and `goal` stay absent
 * until a human has confirmed a permissions model, because inventing a persona
 * would put a guess in front of the agent wearing the same clothes as a fact.
 */
export interface IssuePacket {
  issue: Issue;
  /** Who hits this, when a confirmed role model says so. */
  actor?: string;
  /** What is wrong now, in product terms. */
  currentBehaviour: string;
  /** What the graph should look like instead. */
  targetBehaviour?: string;
  acceptance: string[];
  constraints: string[];
  /** Files to start in, most specific first. */
  likelyFiles: string[];
  /** Design-system primitives already in the codebase for this kind of fix. */
  primitives: string[];
  neighbourhood?: GraphFlowResult;
  /** The command that re-tests exactly this issue. */
  retestCommand: string;
}

export interface IssueGetResult {
  packet: IssuePacket;
}

export interface IssueAcceptParams extends WorkspaceOpenParams {
  id: string;
  /** Why the deviation is intentional. Required: an unexplained accept rots. */
  reason: string;
  /**
   * How the caller established that a person is doing this.
   *
   * Supplied by the CLI from `classifyCaller`, because only the process that
   * owns the terminal can tell. Required, and required to be non-empty: an
   * accept with no attestation is the bug this parameter exists to prevent.
   */
  attestation: string[];
  /** Which pending proposal this grants, if it grants one. */
  grants?: number;
}

export interface IssueAcceptResult {
  issue: Issue;
}

export interface IssueProposeParams extends WorkspaceOpenParams {
  id: string;
  /** The case for accepting. Recorded verbatim for the human who reads it. */
  reason: string;
  by: Actor;
  session?: string;
}

export interface IssueProposeResult {
  issue: Issue;
  /** Index of the proposal just added, for granting it later. */
  index: number;
}

export interface IssueDeclineParams extends WorkspaceOpenParams {
  id: string;
  note?: string;
}

export interface IssueDeclineResult {
  issue: Issue;
  declined: number;
}

export interface IssueRevokeParams extends WorkspaceOpenParams {
  id: string;
  /** Why the acceptance no longer holds. Required: this overturns a decision. */
  reason: string;
  by: Actor;
}

export interface IssueRevokeResult {
  issue: Issue;
  /** The reason the acceptance originally gave, so the caller can echo it. */
  wasAcceptedFor?: string;
  /**
   * Whether the acceptance being revoked had ever been attested.
   *
   * An acceptance recorded before Drumlin checked its caller says `by: human`
   * on nothing but the word of whoever ran the command. Surfacing that at the
   * moment of revocation is the one time somebody is definitely looking.
   */
  wasAttested: boolean;
}

/** Accepted issues, with enough provenance to judge them. */
export interface IssuesAcceptedParams extends WorkspaceOpenParams {}

export interface AcceptedIssue {
  id: string;
  message: string;
  rule: string;
  reason?: string;
  at?: string;
  /** False when nothing recorded how `by: human` was established. */
  attested: boolean;
}

export interface IssuesAcceptedResult {
  accepted: AcceptedIssue[];
}

export interface IssueClaimParams extends WorkspaceOpenParams {
  id: string;
  /** What was changed, and why the caller believes it fixed the issue. */
  note: string;
  /**
   * Who is claiming. Unlike an accept this is taken at face value, because
   * nothing turns on it: the verifier applies the same standard whoever asked.
   */
  by: Actor;
  session?: string;
  /**
   * Verify immediately rather than only recording the claim.
   *
   * Convenient and never privileged: it runs the same verifier with the same
   * standard, and the claim text is not an input to it either way.
   */
  verify?: boolean;
}

export interface IssueClaimResult {
  issue: Issue;
  /** Present only when `verify` was set. */
  verification?: Verification;
}

export interface IssueVerifyParams extends WorkspaceOpenParams {
  /** Omit to verify everything with an unverified claim against it. */
  id?: string;
}

export interface IssueVerifyReport {
  id: string;
  outcome: VerificationOutcome;
  /** What the issue ended up as. Unchanged unless the outcome was `gone`. */
  status: IssueStatus;
  summary: string;
  evidence: string[];
}

export interface IssueVerifyResult {
  verified: IssueVerifyReport[];
  /** Issues that moved to `resolved`. Only the verifier can produce these. */
  resolved: string[];
}

/** One candidate the identity resolver considered, and what persuaded it. */
export interface RenameCandidate {
  from: string;
  to: string;
  score: number;
  because: string[];
}

export interface RenameReport {
  /** Nodes the resolver is confident moved. Issues on these were carried over. */
  renamed: RenameCandidate[];
  /** Plausible but not decisive, so deliberately not acted on. */
  ambiguous: RenameCandidate[];
  /** `UX-` ids whose target was rewritten. */
  retargeted: string[];
}

export interface IssuesExportParams extends WorkspaceOpenParams {
  /** Which formatter, and the name recorded against each exported issue. */
  target: string;
  /** Only issues never yet exported to this target. */
  onlyNew?: boolean;
  /** Include issues a human already accepted. */
  includeAccepted?: boolean;
  /** Include issues no longer detected but still on record. */
  includeClosed?: boolean;
  /**
   * Write the export back onto each issue.
   *
   * Off for a preview, because marking issues as exported when the developer
   * was only looking would make the next real export skip them.
   */
  record?: boolean;
}

export interface IssuesExportResult {
  issues: Issue[];
  /** How many were left out, and why, so the CLI can say so. */
  skipped: { alreadyExported: number; accepted: number; closed: number };
  recorded: boolean;
}

export interface SessionStartParams extends GraphGetParams {
  /** The host's own conversation identifier, when it has one. */
  sessionId?: string;
  /** Free-form note recorded with the baseline, e.g. the agent model. */
  label?: string;
}

export interface SessionStartResult {
  sessionId: string;
  /** How many open findings existed before the session started. */
  baseline: number;
  warm: boolean;
}

export interface SessionTouchParams {
  sessionId: string;
  files: string[];
}

export interface SessionTouchResult {
  /** Files recorded as changed. Non-source paths are dropped. */
  recorded: number;
  totalChanged: number;
}

export interface SessionDiffParams extends GraphGetParams {
  sessionId: string;
  /** Only report findings at this severity or above. */
  severity?: Severity;
  /**
   * Fold what is reported into the baseline, so it is reported once.
   *
   * The `stop` hook sets this. Without it, a finding the agent chose not to
   * fix would come back at the end of every subsequent turn, and a tool that
   * repeats itself gets muted.
   */
  absorb?: boolean;
  /**
   * Withhold findings about files written within this many milliseconds.
   *
   * Defaults to zero, meaning off. For a caller that reports while code is
   * still being written; `stop` is not one, since a turn that has ended is
   * finished code. See the note on `GRACE_WINDOW_MS`.
   */
  graceMs?: number;
}

export interface SessionDiffResult {
  /** Findings absent from the baseline, so attributable to this session. */
  introduced: Finding[];
  /** Findings that were already there. Counted, not listed. */
  preexisting: number;
  /** Findings withheld by the grace window. Zero unless `graceMs` was set. */
  graceWithheld: number;
  /**
   * New findings in code this session did not touch.
   *
   * Almost always a hand-typed edit made while the agent worked. Real, worth
   * counting, and not the agent's to answer for.
   */
  elsewhere: number;
  /**
   * Whether attribution was applied.
   *
   * False when the session recorded no edits, which is ambiguous: the turn
   * wrote nothing, or `afterFileEdit` never fired. The diff falls back to
   * fingerprints alone, and this says so rather than letting the caller
   * assume a narrower result than it got.
   */
  attributed?: boolean;
  changedFiles: string[];
  /** False when no baseline was recorded, so nothing can be attributed. */
  hadBaseline: boolean;
}

export interface SessionEndParams {
  sessionId: string;
}

export interface SessionEndResult {
  closed: boolean;
}

/**
 * The wire surface.
 *
 * Method names are the ones from Context/14 Daemon IPC Methods, so the daemon
 * wraps them rather than renaming them. `session.*` has no counterpart there
 * because continuous editing is a Milestone B concern the canonical API never
 * had to describe.
 */
export interface EngineMethods {
  "workspace.open": {
    params: WorkspaceOpenParams;
    result: WorkspaceOpenResult;
  };
  "workspace.status": {
    params: WorkspaceStatusParams;
    result: WorkspaceStatusResult;
  };
  "graph.get": { params: GraphGetParams; result: GraphGetResult };
  "graph.flow": { params: GraphFlowParams; result: GraphFlowResult };
  "check.run": { params: CheckRunParams; result: CheckRunResult };
  "context.infer": { params: ContextInferParams; result: ContextInferResult };
  "project.summary": {
    params: ProjectSummaryParams;
    result: ProjectSummaryResult;
  };
  "issues.list": { params: IssuesListParams; result: IssuesListResult };
  "issue.get": { params: IssueGetParams; result: IssueGetResult };
  "issue.accept": { params: IssueAcceptParams; result: IssueAcceptResult };
  "issue.propose": { params: IssueProposeParams; result: IssueProposeResult };
  "issue.decline": { params: IssueDeclineParams; result: IssueDeclineResult };
  "issue.revoke": { params: IssueRevokeParams; result: IssueRevokeResult };
  "issues.accepted": {
    params: IssuesAcceptedParams;
    result: IssuesAcceptedResult;
  };
  "issue.claim": { params: IssueClaimParams; result: IssueClaimResult };
  "issue.verify": { params: IssueVerifyParams; result: IssueVerifyResult };
  "issues.export": { params: IssuesExportParams; result: IssuesExportResult };
  "session.start": { params: SessionStartParams; result: SessionStartResult };
  "session.touch": { params: SessionTouchParams; result: SessionTouchResult };
  "session.diff": { params: SessionDiffParams; result: SessionDiffResult };
  "session.end": { params: SessionEndParams; result: SessionEndResult };
}

/** Methods an agent may call. Everything else is human or first-party only. */
export const AGENT_READABLE_METHODS = [
  "project.summary",
  "graph.flow",
  "issue.get",
  "check.run",
] as const satisfies readonly EngineMethod[];

export type EngineMethod = keyof EngineMethods;

export interface Engine {
  request<M extends EngineMethod>(
    method: M,
    params: EngineMethods[M]["params"],
  ): Promise<EngineMethods[M]["result"]>;
}
