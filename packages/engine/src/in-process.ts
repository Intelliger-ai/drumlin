import { existsSync, readFileSync } from "node:fs";
import {
  describeApp,
  indexApp,
  inferPermissionModel,
  isAnalyzableSource,
  relativePath,
  resolveApp,
  type IndexResult,
  type NextApp,
} from "@drumlin/indexer";
import {
  computeCacheKey,
  DerivedCache,
  IssueStore,
  readConfig,
  readIdentityBaseline,
  readPermissions,
  repoPaths,
  SessionStore,
  writeIdentityBaseline,
  writePermissions,
} from "@drumlin/repo";
import {
  attributeFindings,
  dependentCone,
  entryPoints,
  findingFiles,
  GraphView,
  diffObserved,
  identitySnapshot,
  matchGraphs,
  reconcile,
  retargetIssues,
  rulesById,
  runRules,
  outcomeStatus,
  outcomeSummary,
  verifyIssue,
  type GraphIdentitySnapshot,
  type RuleContext,
} from "@drumlin/core";
import {
  allowedTransitions,
  canTransition,
  findingFingerprint,
  mayTransition,
  fromHuman,
  fromRepository,
  inferred,
  isConfirmed,
  isOpen,
  issueId,
  parseObservedGraph,
  PERMISSIONS_SCHEMA_VERSION,
  severityRank,
  withoutLocaleSegments,
  type Finding,
  type GraphDocument,
  type Issue,
  type IssueStatus,
  type PermissionsDocument,
  type Severity,
} from "@drumlin/model";
import { flowFor } from "./flow.js";
import { buildPacket } from "./packet.js";
import type {
  AttributionSummary,
  Belief,
  CheckRunParams,
  CheckRunResult,
  ContextInferParams,
  ContextInferResult,
  Engine,
  EngineMethod,
  EngineMethods,
  GraphFlowParams,
  GraphFlowResult,
  GraphGetParams,
  GraphGetResult,
  IssueAcceptParams,
  IssueAcceptResult,
  AcceptedIssue,
  IssueClaimParams,
  IssueClaimResult,
  IssueRevokeParams,
  IssueRevokeResult,
  IssuesAcceptedParams,
  IssuesAcceptedResult,
  IssueDeclineParams,
  IssueDeclineResult,
  IssueVerifyParams,
  IssueVerifyReport,
  IssueVerifyResult,
  IssueGetParams,
  IssueGetResult,
  IssueProposeParams,
  IssueProposeResult,
  IssuesExportParams,
  IssuesExportResult,
  IssuesListParams,
  IssuesListResult,
  ProjectSummaryParams,
  ProjectSummaryResult,
  RenameReport,
  SessionDiffParams,
  SessionDiffResult,
  SessionEndParams,
  SessionEndResult,
  SessionStartParams,
  SessionStartResult,
  SessionTouchParams,
  SessionTouchResult,
  Uncertainty,
  WorkspaceOpenParams,
  WorkspaceOpenResult,
  WorkspaceStatusParams,
  WorkspaceStatusResult,
} from "./types.js";

/**
 * The in-process engine.
 *
 * Everything a command needs goes through `request`, so the day this becomes a
 * daemon the commands do not change — only the transport behind this class.
 */
export class InProcessEngine implements Engine {
  async request<M extends EngineMethod>(
    method: M,
    params: EngineMethods[M]["params"],
  ): Promise<EngineMethods[M]["result"]> {
    switch (method) {
      case "workspace.open":
        return this.workspaceOpen(
          params as WorkspaceOpenParams,
        ) as EngineMethods[M]["result"];
      case "workspace.status":
        return this.workspaceStatus(
          params as WorkspaceStatusParams,
        ) as EngineMethods[M]["result"];
      case "graph.get":
        return (await this.graphGet(
          params as GraphGetParams,
        )) as EngineMethods[M]["result"];
      case "check.run":
        return (await this.checkRun(
          params as CheckRunParams,
        )) as EngineMethods[M]["result"];
      case "context.infer":
        return this.contextInfer(
          params as ContextInferParams,
        ) as EngineMethods[M]["result"];
      case "issues.list":
        return this.issuesList(
          params as IssuesListParams,
        ) as EngineMethods[M]["result"];
      case "graph.flow":
        return (await this.graphFlow(
          params as GraphFlowParams,
        )) as EngineMethods[M]["result"];
      case "project.summary":
        return (await this.projectSummary(
          params as ProjectSummaryParams,
        )) as EngineMethods[M]["result"];
      case "issue.get":
        return (await this.issueGet(
          params as IssueGetParams,
        )) as EngineMethods[M]["result"];
      case "issue.accept":
        return this.issueAccept(
          params as IssueAcceptParams,
        ) as EngineMethods[M]["result"];
      case "issue.propose":
        return this.issuePropose(
          params as IssueProposeParams,
        ) as EngineMethods[M]["result"];
      case "issue.decline":
        return this.issueDecline(
          params as IssueDeclineParams,
        ) as EngineMethods[M]["result"];
      case "issue.revoke":
        return this.issueRevoke(
          params as IssueRevokeParams,
        ) as EngineMethods[M]["result"];
      case "issues.accepted":
        return this.issuesAccepted(
          params as IssuesAcceptedParams,
        ) as EngineMethods[M]["result"];
      case "issue.claim":
        return (await this.issueClaim(
          params as IssueClaimParams,
        )) as EngineMethods[M]["result"];
      case "issue.verify":
        return (await this.issueVerify(
          params as IssueVerifyParams,
        )) as EngineMethods[M]["result"];
      case "issues.export":
        return this.issuesExport(
          params as IssuesExportParams,
        ) as EngineMethods[M]["result"];
      case "session.start":
        return (await this.sessionStart(
          params as SessionStartParams,
        )) as EngineMethods[M]["result"];
      case "session.touch":
        return this.sessionTouch(
          params as SessionTouchParams,
        ) as EngineMethods[M]["result"];
      case "session.diff":
        return (await this.sessionDiff(
          params as SessionDiffParams,
        )) as EngineMethods[M]["result"];
      case "session.end":
        return this.sessionEnd(
          params as SessionEndParams,
        ) as EngineMethods[M]["result"];
      default:
        throw new Error(`Engine method not implemented: ${method}`);
    }
  }

  /**
   * Index, evaluate rules, and reconcile the result against issues on record.
   *
   * The reconciliation step is what makes a run comparable to the last one:
   * findings are recomputed from scratch every time and have no identity, so
   * without it every `UX-` number and every acceptance decision would be lost.
   */
  protected async checkRun(params: CheckRunParams): Promise<CheckRunResult> {
    const app = resolveAppFor(params);
    // Sampled before anything runs, so a command can never observe itself
    // having created the directory it is checking for.
    const persisted = existsSync(repoPaths(app.root).dir);
    const graphResult = await this.graphGet(params);

    const view = new GraphView(graphResult.graph);
    const config = readConfig(app.root);
    const permissions = readPermissions(app.root);

    const declared = entryPoints(view, { declared: config.entryPoints });
    const active = rulesById(params.rules).filter(
      (rule) => !config.disabledRules.includes(rule.id),
    );

    const context: RuleContext = { view, entryPoints: declared };
    if (isConfirmed(permissions)) context.permissions = permissions;

    const run = runRules(active, context);

    // Runtime findings join the static ones before reconcile, so a problem the
    // browser found is an issue in exactly the same sense as one the rules
    // found: same numbering, same accept path, same export.
    const runtime = params.observed
      ? this.runtimeFindings(params.observed, graphResult.graph)
      : [];
    const findings = runtime.length > 0
      ? [...run.findings, ...runtime]
      : run.findings;

    // Issues are reconciled from the whole run, never from the scoped report.
    // Narrowing here would renumber issues differently depending on which
    // files a developer happened to have open, which is the one thing a
    // durable `UX-` identifier cannot survive.
    const store = new IssueStore(app.root);

    // Renames are resolved *before* fingerprints are compared, so reconcile
    // sees issues that already speak the new graph's language. Without this a
    // route rename retires every `UX-` number on that screen and drops the
    // acceptance decisions with them — and the developer's only observation is
    // that findings they accepted came back as new.
    const renames = this.resolveRenames(app.root, graphResult.graph, persisted);

    const reconciled = reconcile({
      findings,
      existing: renames.issues,
      now: new Date().toISOString(),
      allocateId: (fingerprint) => store.idFor(fingerprint).id,
    });

    if (persisted) {
      for (const issue of reconciled.issues) store.write(issue);
      store.flush();
    }

    const reported = this.scopeToChange(params, findings, view);

    const result: CheckRunResult = {
      findings: reported.findings,
      issues: reconciled.issues,
      counts: reconciled.counts,
      graph: graphResult.graph,
      stats: graphResult.stats,
      cached: graphResult.cached,
      suppressed: run.suppressed.length,
      ruleErrors: run.errors,
      // Runtime findings count as raw output too. Leaving them out would make
      // the "N raw findings reduced to M" line report a reduction that never
      // happened, since these do not pass through deduplication.
      rawFindingCount: run.rawCount + runtime.length,
      persisted,
    };
    if (reported.attribution) result.attribution = reported.attribution;
    if (renames.report) result.renames = renames.report;
    return result;
  }

  /**
   * Load a browser observation and diff it against the source.
   *
   * Failures here are thrown rather than swallowed. Every other input to a
   * check has a sensible empty default, but an observation does not: silently
   * treating an unreadable file as "no observation" would produce a clean
   * report from a run whose runtime half never happened, which is the most
   * misleading output the tool could give.
   */
  private runtimeFindings(path: string, graph: GraphDocument): Finding[] {
    if (!existsSync(path)) {
      // Do not name a command to run here. This said "record one with
      // `drumlin observe` first", and no `observe` command is registered — the
      // walk and the diff are built, the browser adapter that would drive them
      // is not. Sending someone to a command that answers `Unknown command` is
      // worse than the missing file they started with.
      throw new Error(
        `No observation at ${path}.\n` +
          `  --observed diffs a recorded browser run against the source. ` +
          `Nothing in Drumlin records one yet, so the file has to come from ` +
          `your own harness, in the shape of ObservedGraph in @drumlin/model.\n` +
          `  Drop --observed to run the static rules alone.`,
      );
    }

    let observed;
    try {
      observed = parseObservedGraph(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      throw new Error(
        `${path} is not a usable observation: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return diffObserved(graph, observed);
  }

  /**
   * Match this graph against the last one, and carry issues across renames.
   *
   * The baseline is rewritten on every persisted run, which makes the
   * comparison always "since the previous check" rather than "since some
   * branch point". That is the right granularity for the editor loop, where a
   * rename is observed one edit after it happens and the neighbourhood has not
   * had time to drift. Comparing against `main` is a different feature — see
   * Regression Baselines — and wants its own stored snapshot.
   */
  private resolveRenames(
    root: string,
    graph: GraphDocument,
    persisted: boolean,
  ): { issues: Issue[]; report?: RenameReport } {
    const store = new IssueStore(root);
    const existing = store.list();

    // Nowhere to keep a baseline means nowhere for ids to be durable either,
    // so there is nothing to protect.
    if (!persisted) return { issues: existing };

    const baseline = readIdentityBaseline<GraphIdentitySnapshot>(root);
    const snapshot = identitySnapshot(graph, {
      generatedAt: new Date().toISOString(),
      ...(graph.workspace?.commit ? { commit: graph.workspace.commit } : {}),
    });
    writeIdentityBaseline(root, snapshot);

    if (!baseline) return { issues: existing };

    const match = matchGraphs(baseline, snapshot);
    if (match.renamed.length === 0 && match.ambiguous.length === 0) {
      return { issues: existing };
    }

    const retargeted = retargetIssues(existing, match);

    return {
      issues: retargeted.issues,
      report: {
        renamed: match.renamed.map((entry) => ({
          from: entry.before,
          to: entry.after,
          score: Math.round(entry.score * 100) / 100,
          because: entry.because,
        })),
        // Surfaced rather than swallowed. A near-miss the resolver declined to
        // act on is exactly what somebody debugging a lost `UX-` number needs
        // to see, and it is how a badly tuned threshold becomes visible.
        ambiguous: match.ambiguous.map((entry) => ({
          from: entry.before,
          to: entry.after,
          score: Math.round(entry.score * 100) / 100,
          because: entry.because,
        })),
        retargeted: retargeted.moved.map((entry) => entry.id),
      },
    };
  }

  /**
   * Narrow the reported findings to a set of changed files.
   *
   * See DEC-0003. The rules have already run over the entire graph by the time
   * this is called, which is the point: attribution is a presentation
   * decision, and treating it as an analysis decision would break every rule
   * whose evidence is the absence of something.
   */
  private scopeToChange(
    params: CheckRunParams,
    findings: readonly Finding[],
    view: GraphView,
  ): { findings: Finding[]; attribution?: AttributionSummary } {
    const changed = params.changed;
    if (!changed) return { findings: [...findings] };

    const app = resolveAppFor(params);
    // Two filters, both of which change the answer. Paths outside the app are
    // another package's business, and a changed README cannot introduce a UX
    // finding — counting it makes the scope report claim work it did not do.
    const relative = changed
      .map((file) => relativePath(app.root, file))
      .filter((file) => !file.startsWith("..") && isAnalyzableSource(file))
      .sort();

    const cone = dependentCone(view.document.imports, relative);
    const { attributed } = attributeFindings(findings, cone, view);

    return {
      findings: attributed,
      attribution: {
        changedFiles: relative,
        coneSize: cone.size,
        totalFindings: findings.length,
      },
    };
  }

  protected contextInfer(params: ContextInferParams): ContextInferResult {
    const app = resolveAppFor(params);
    const inference = inferPermissionModel(app);

    const beliefs: Belief[] = [
      ...inference.roles.map((role) => ({
        subject: "role",
        statement: role.id,
        confidence: role.confidence,
        provenance: fromRepository(
          role.locations.slice(0, 4).map((location) => location.file),
          role.confidence,
        ),
        detail: role.reason,
      })),
      ...inference.capabilityFlags.map((flag) => ({
        subject: "capability",
        statement: flag.id,
        confidence: flag.confidence,
        provenance: fromRepository(
          flag.locations.slice(0, 4).map((location) => location.file),
          flag.confidence,
        ),
        detail: flag.reason,
      })),
      ...inference.groups.map((group) => ({
        subject: "role group",
        statement: `${group.id} = ${group.members.join(", ")}`,
        confidence: 0.85,
        provenance: fromRepository(
          group.locations.map((location) => location.file),
          0.85,
        ),
        detail: "named grouping of roles",
      })),
    ];

    const uncertainties: Uncertainty[] = inference.questions.map((question) => ({
      subject: question.subject,
      question: question.question,
      ...(question.candidates ? { candidates: question.candidates } : {}),
    }));

    const result: ContextInferResult = { beliefs, uncertainties };

    if (params.write === true || params.confirm === true) {
      const confirmed = params.confirm === true;
      const provenanceFor = (files: string[], confidence: number) =>
        confirmed ? fromHuman(files) : inferred(files, confidence);

      const document: PermissionsDocument = {
        schemaVersion: PERMISSIONS_SCHEMA_VERSION,
        roles: inference.roles.map((role) => ({
          id: role.id,
          description: role.reason,
          provenance: provenanceFor(
            role.locations.slice(0, 4).map((location) => location.file),
            role.confidence,
          ),
        })),
        permissions: inference.capabilityFlags.map((flag) => ({
          id: flag.id,
          description: flag.reason,
          // Which roles hold a capability is exactly what cannot be inferred.
          roles: [],
          provenance: provenanceFor(
            flag.locations.slice(0, 4).map((location) => location.file),
            flag.confidence,
          ),
        })),
      };
      if (confirmed) document.confirmedAt = new Date().toISOString();

      result.written = writePermissions(app.root, document);
      result.confirmed = confirmed;
    }

    return result;
  }

  protected async graphFlow(params: GraphFlowParams): Promise<GraphFlowResult> {
    const app = resolveAppFor(params);
    const graphResult = await this.graphGet(params);
    const view = new GraphView(graphResult.graph);
    return flowFor(view, params.route, new IssueStore(app.root).list());
  }

  protected async projectSummary(
    params: ProjectSummaryParams,
  ): Promise<ProjectSummaryResult> {
    const app = resolveAppFor(params);
    const graphResult = await this.graphGet(params);
    const view = new GraphView(graphResult.graph);

    const config = readConfig(app.root);
    const declared = entryPoints(view, { declared: config.entryPoints });
    const permissions = readPermissions(app.root);
    const issues = new IssueStore(app.root).list();

    const bySeverity: Record<Severity, number> = {
      info: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };
    let open = 0;
    let accepted = 0;
    for (const issue of issues) {
      if (issue.status === "accepted") accepted += 1;
      if (!isOpen(issue.status)) continue;
      open += 1;
      bySeverity[issue.severity] += 1;
    }

    const result: ProjectSummaryResult = {
      root: app.root,
      router: app.router,
      counts: {
        screens: graphResult.stats.screens,
        states: graphResult.stats.states,
        actions: graphResult.stats.actions,
        components: graphResult.stats.components,
        edges: graphResult.stats.edges,
      },
      entryPoints: [...declared]
        .map((id) => view.labelOf(id))
        .sort()
        .slice(0, 20),
      sections: routeSections(view),
      issues: { total: issues.length, open, accepted, bySeverity },
      persisted: existsSync(repoPaths(app.root).dir),
    };

    if (isConfirmed(permissions)) {
      result.roles = permissions.roles.map((role) => role.id);
    }

    return result;
  }

  protected async issueGet(params: IssueGetParams): Promise<IssueGetResult> {
    const app = resolveAppFor(params);
    const store = new IssueStore(app.root);
    const issue = store.read(normalizeIssueId(params.id));

    if (!issue) throw missingIssue(app.root, params.id);

    const graphResult = await this.graphGet(params);
    const permissions = readPermissions(app.root);

    return {
      packet: buildPacket({
        issue,
        view: new GraphView(graphResult.graph),
        issues: store.list(),
        ...(params.app ? { appFlag: params.app } : {}),
        ...(permissions ? { permissions } : {}),
      }),
    };
  }

  /**
   * Record a deviation as intentional.
   *
   * `accepted` is the one status a human owns outright, per Context/11, and it
   * is deliberately unreachable from the MCP surface: an agent that can mark
   * its own findings acceptable will eventually do so to finish a turn.
   *
   * A freshly detected issue moves through `confirmed` on the way, because
   * accepting one means somebody looked at it, which is exactly what confirmed
   * asserts.
   */
  protected issueAccept(params: IssueAcceptParams): IssueAcceptResult {
    const app = resolveAppFor(params);
    const paths = repoPaths(app.root);
    if (!existsSync(paths.dir)) {
      throw new Error(
        "No .drumlin/ directory, so an accept would not survive. Run `drumlin init` first.",
      );
    }

    const reason = params.reason?.trim();
    if (!reason) {
      throw new Error(
        "An accept needs a reason: an unexplained suppression is indistinguishable from a bug.",
      );
    }

    // The check that closes the hole. The CLI establishes this from the
    // terminal it owns; the daemon refuses the method outright, so there is no
    // caller that can reach here without having been classified.
    const attestation = (params.attestation ?? []).filter(
      (item) => item.trim().length > 0,
    );
    if (attestation.length === 0) {
      throw new Error(
        "An accept needs an attestation describing how it was established " +
          "that a person is doing this. Nothing should reach this method " +
          "without one — if you are seeing this, an unattested caller found a " +
          "way in, which is a bug worth reporting.",
      );
    }

    const store = new IssueStore(app.root);
    const id = normalizeIssueId(params.id);
    const issue = store.read(id);
    if (!issue) throw missingIssue(app.root, id);

    if (issue.status === "accepted") return { issue };

    const now = new Date().toISOString();
    const history = [...(issue.history ?? [])];
    let status = issue.status;

    if (!canTransition(status, "accepted")) {
      if (!canTransition(status, "confirmed")) {
        throw new Error(
          `${id} is ${status}, which cannot be accepted. ` +
            `Allowed from here: ${allowedTransitions(status).join(", ") || "nothing"}.`,
        );
      }
      history.push({
        at: now,
        from: status,
        to: "confirmed",
        by: "human",
        attestation,
      });
      status = "confirmed";
    }

    history.push({
      at: now,
      from: status,
      to: "accepted",
      by: "human",
      note: reason,
      attestation,
    });

    // Granting an agent's proposal rather than deciding from scratch. Recorded
    // as granted rather than deleted, so the reasoning that persuaded someone
    // survives next to the decision it produced.
    const proposals = [...(issue.proposals ?? [])];
    if (params.grants !== undefined) {
      const proposal = proposals[params.grants];
      if (!proposal) throw new Error(`${id} has no proposal ${params.grants}.`);
      proposals[params.grants] = {
        ...proposal,
        state: "granted",
        decidedAt: now,
        decidedNote: reason,
      };
    }

    const updated: Issue = {
      ...issue,
      status: "accepted",
      updatedAt: now,
      // The reason belongs on the issue as well as in history: a reader
      // scanning issue files should not have to walk an event log to find out
      // why something is silent.
      acceptedReason: reason,
      history,
      ...(proposals.length > 0 ? { proposals } : {}),
    };

    store.write(updated);
    store.flush();
    return { issue: updated };
  }

  /**
   * An agent's case for accepting, recorded without acting on it.
   *
   * The counterpart to refusing agents the accept itself. An agent that has
   * just read the code often does know a finding is wrong, and giving it no
   * way to say so leaves it two options: silence the finding by whatever means
   * it can, or argue in chat where nothing is recorded. Neither is what you
   * want. So it argues here, in the issue file, and a person decides.
   *
   * Reachable over the socket, unlike `issue.accept`, because a proposal
   * changes no status and suppresses nothing.
   */
  protected issuePropose(params: IssueProposeParams): IssueProposeResult {
    const app = resolveAppFor(params);
    if (!existsSync(repoPaths(app.root).dir)) {
      throw new Error(
        "No .drumlin/ directory, so a proposal would not survive. Run `drumlin init` first.",
      );
    }

    const reason = params.reason?.trim();
    if (!reason) {
      throw new Error(
        "A proposal needs a reason. It is the whole content of the proposal: " +
          "a person is going to read it and decide.",
      );
    }

    const store = new IssueStore(app.root);
    const id = normalizeIssueId(params.id);
    const issue = store.read(id);
    if (!issue) throw missingIssue(app.root, id);

    if (issue.status === "accepted") {
      throw new Error(`${id} is already accepted. Nothing to propose.`);
    }

    const proposals = [...(issue.proposals ?? [])];
    const existing = proposals.findIndex(
      (proposal) => proposal.state === "pending",
    );
    if (existing !== -1) {
      throw new Error(
        `${id} already has a proposal awaiting a decision:\n` +
          `  "${proposals[existing]!.reason}"\n` +
          `Adding another would not make it more likely to be read.`,
      );
    }

    proposals.push({
      kind: "accept",
      by: params.by,
      at: new Date().toISOString(),
      reason,
      ...(params.session ? { session: params.session } : {}),
      state: "pending",
    });

    const updated: Issue = { ...issue, proposals };
    store.write(updated);
    store.flush();

    return { issue: updated, index: proposals.length - 1 };
  }

  /** Turn down every pending proposal on an issue, with an optional note. */
  protected issueDecline(params: IssueDeclineParams): IssueDeclineResult {
    const app = resolveAppFor(params);
    const store = new IssueStore(app.root);
    const id = normalizeIssueId(params.id);
    const issue = store.read(id);
    if (!issue) throw missingIssue(app.root, id);

    const now = new Date().toISOString();
    let declined = 0;
    const proposals = (issue.proposals ?? []).map((proposal) => {
      if (proposal.state !== "pending") return proposal;
      declined += 1;
      return {
        ...proposal,
        state: "declined" as const,
        decidedAt: now,
        ...(params.note ? { decidedNote: params.note } : {}),
      };
    });

    if (declined === 0) return { issue, declined: 0 };

    const updated: Issue = { ...issue, proposals };
    store.write(updated);
    store.flush();
    return { issue: updated, declined };
  }

  /**
   * Undo an acceptance.
   *
   * The way back out, which the first version of the decision machinery did
   * not have. Everything about `accept` was built to make it hard to obtain —
   * a terminal, a typed confirmation, a recorded attestation — and none of that
   * helps if a wrong one cannot be undone. The first real acceptance in a real
   * project was a forged one, and there was no command that could reverse it.
   *
   * Lighter than `accept` but not open. There is no terminal check and no
   * typed confirmation, because revoking makes Drumlin louder and only silence
   * needs that much friction. But it still goes through the ownership table,
   * which lands a revoked issue back in `confirmed` — and `confirmed` means
   * somebody with standing called this a real problem. An agent overturning a
   * person's recorded decision would be asserting exactly that standing, so
   * the table refuses it, and the refusal is the same one that protects every
   * other status rather than a rule invented here.
   *
   * Nothing is erased. The acceptance stays in history with its reason, and the
   * revocation is appended next to it, because "this was accepted and then
   * un-accepted, for these two stated reasons" is the whole value of the record.
   */
  protected issueRevoke(params: IssueRevokeParams): IssueRevokeResult {
    const app = resolveAppFor(params);
    const paths = repoPaths(app.root);
    if (!existsSync(paths.dir)) {
      throw new Error(
        "No .drumlin/ directory, so there are no decisions to revoke.",
      );
    }

    const reason = params.reason?.trim();
    if (!reason) {
      throw new Error(
        "A revocation needs a reason. It overturns a recorded decision, and " +
          "the next person to look will want to know what changed.",
      );
    }

    const store = new IssueStore(app.root);
    const id = normalizeIssueId(params.id);
    const issue = store.read(id);
    if (!issue) throw missingIssue(app.root, id);

    if (issue.status !== "accepted") {
      throw new Error(
        `${id} is ${issue.status}, not accepted, so there is nothing to revoke.`,
      );
    }

    const verdict = mayTransition(params.by, "accepted", "confirmed");
    if (!verdict.ok) throw new Error(verdict.reason);

    const acceptance = [...(issue.history ?? [])]
      .reverse()
      .find((event) => event.to === "accepted");

    const now = new Date().toISOString();
    const updated: Issue = {
      ...issue,
      status: "confirmed",
      updatedAt: now,
      history: [
        ...(issue.history ?? []),
        {
          at: now,
          from: "accepted",
          to: "confirmed",
          by: params.by,
          note: reason,
        },
      ],
    };
    // Cleared from the issue itself so it stops reading as accepted at a
    // glance, while the reason survives in history where it belongs.
    delete updated.acceptedReason;

    store.write(updated);
    store.flush();

    return {
      issue: updated,
      ...(issue.acceptedReason ? { wasAcceptedFor: issue.acceptedReason } : {}),
      wasAttested: (acceptance?.attestation?.length ?? 0) > 0,
    };
  }

  /**
   * Every acceptance, with enough provenance to judge it.
   *
   * Exists because acceptances are invisible by design — an accepted finding
   * is one that stopped being reported, so nothing brings it back to your
   * attention. That is correct for a decision somebody made deliberately and
   * wrong for the pile of them a year later, and it is how a forged acceptance
   * stays hidden. `attested` is the field worth reading.
   */
  protected issuesAccepted(
    params: IssuesAcceptedParams,
  ): IssuesAcceptedResult {
    const app = resolveAppFor(params);
    if (!existsSync(repoPaths(app.root).dir)) {
      throw new Error("No .drumlin/ directory, so nothing has been accepted.");
    }

    const accepted: AcceptedIssue[] = [];

    for (const issue of new IssueStore(app.root).list()) {
      if (issue.status !== "accepted") continue;
      const event = [...(issue.history ?? [])]
        .reverse()
        .find((entry) => entry.to === "accepted");

      accepted.push({
        id: issue.id,
        message: issue.message,
        rule: issue.rule.id,
        ...(issue.acceptedReason ? { reason: issue.acceptedReason } : {}),
        ...(event?.at ? { at: event.at } : {}),
        attested: (event?.attestation?.length ?? 0) > 0,
      });
    }

    return { accepted };
  }

  /**
   * Record that somebody believes an issue is fixed.
   *
   * Freely available to agents, and it closes nothing. The distinction that
   * makes that safe is the one in `mayTransition`: a claim moves an issue to
   * `candidate_resolved`, and the only exit from `candidate_resolved` is
   * `verifying`, from which only the verifier continues. So the most an agent
   * can achieve by claiming is to get its work checked.
   *
   * The note is required and is never read by the verifier. It is there for the
   * person who later wants to know what was attempted — including, especially,
   * when the verification failed.
   */
  protected async issueClaim(
    params: IssueClaimParams,
  ): Promise<IssueClaimResult> {
    const app = resolveAppFor(params);
    if (!existsSync(repoPaths(app.root).dir)) {
      throw new Error(
        "No .drumlin/ directory, so a claim would not survive. Run `drumlin init` first.",
      );
    }

    const note = params.note?.trim();
    if (!note) {
      throw new Error(
        "A claim needs to say what changed. The verifier does not read it, " +
          "but whoever reads this issue after a failed verification will.",
      );
    }

    const store = new IssueStore(app.root);
    const id = normalizeIssueId(params.id);
    const issue = store.read(id);
    if (!issue) throw missingIssue(app.root, id);

    const caller = params.by;
    const now = new Date().toISOString();

    // Every status change goes through the ownership check, including this
    // one. `candidate_resolved` is an agent's to set, and going straight to
    // `resolved` is refused here rather than being prevented by the absence of
    // any code that tries.
    let status = issue.status;
    const history = [...(issue.history ?? [])];
    if (status !== "candidate_resolved") {
      const verdict = mayTransition(caller, status, "candidate_resolved");
      if (!verdict.ok) {
        throw new Error(
          `${id} is ${status}, which cannot be claimed as fixed.\n` +
            (status === "accepted"
              ? "  It was accepted, so there is nothing to fix. " +
                "`drumlin check` will reopen it if the situation changed."
              : `  ${verdict.reason}`),
        );
      }
      history.push({
        at: now,
        from: status,
        to: "candidate_resolved",
        by: caller,
        note,
      });
      status = "candidate_resolved";
    }

    const claims = [
      ...(issue.claims ?? []),
      {
        by: caller,
        at: now,
        note,
        ...(params.session ? { session: params.session } : {}),
      },
    ];

    const claimed: Issue = { ...issue, status, updatedAt: now, history, claims };
    store.write(claimed);
    store.flush();

    if (!params.verify) return { issue: claimed };

    const run = await this.issueVerify({ root: app.root, id });
    const after = new IssueStore(app.root).read(id) ?? claimed;
    const verification = after.verifications?.at(-1);
    void run;
    return {
      issue: after,
      ...(verification ? { verification } : {}),
    };
  }

  /**
   * Decide whether claimed fixes actually hold.
   *
   * The only path to `resolved`. It works by throwing away everything anybody
   * said and re-deriving from source: a fresh graph with the cache disabled,
   * every rule run over it, and then a comparison against the issue's own
   * fingerprint. The claim is carried into the record as context and is not an
   * input to the decision.
   *
   * Uncached deliberately. Verifying against a cached graph would let a stale
   * entry resolve an issue, which is the same failure as trusting the claim
   * with extra steps.
   */
  protected async issueVerify(
    params: IssueVerifyParams,
  ): Promise<IssueVerifyResult> {
    const app = resolveAppFor(params);
    if (!existsSync(repoPaths(app.root).dir)) {
      throw new Error(
        "No .drumlin/ directory, so there is nothing to verify against. " +
          "Run `drumlin init`, then `drumlin check`.",
      );
    }

    const store = new IssueStore(app.root);
    const targets: Issue[] = [];
    if (params.id) {
      const id = normalizeIssueId(params.id);
      const issue = store.read(id);
      if (!issue) throw missingIssue(app.root, id);
      targets.push(issue);
    } else {
      // Everything with a claim nobody has checked yet. Verifying issues that
      // were never claimed would burn a full uncached run to tell people what
      // `drumlin check` already told them.
      for (const issue of store.list()) {
        if (issue.claims?.some((claim) => !claim.verifiedAt)) targets.push(issue);
      }
    }

    if (targets.length === 0) return { verified: [], resolved: [] };

    const graphResult = await this.graphGet({ root: app.root, cache: false });
    const view = new GraphView(graphResult.graph);
    const config = readConfig(app.root);
    const permissions = readPermissions(app.root);
    const active = rulesById(undefined).filter(
      (rule) => !config.disabledRules.includes(rule.id),
    );
    const context: RuleContext = {
      view,
      entryPoints: entryPoints(view, { declared: config.entryPoints }),
    };
    if (isConfirmed(permissions)) context.permissions = permissions;
    const run = runRules(active, context);

    // What actually executed, taken from the run rather than read off its
    // output. A rule that found nothing is the normal case in working code and
    // must not be mistaken for a rule that was never asked.
    const errored = new Set(run.errors.map((error) => error.ruleId));
    const rulesRun = active
      .map((rule) => rule.id)
      .filter((id) => !errored.has(id));

    const now = new Date().toISOString();
    const verified: IssueVerifyReport[] = [];
    const resolved: string[] = [];

    for (const issue of targets) {
      const pending = issue.claims?.filter((claim) => !claim.verifiedAt) ?? [];
      const verification = verifyIssue({
        issue,
        findings: run.findings,
        rulesRun,
        graph: graphResult.graph,
        now,
        ...(pending.at(-1) ? { claim: pending.at(-1)!.note } : {}),
      });

      let status = issue.status;
      const history = [...(issue.history ?? [])];
      const target = outcomeStatus(verification.outcome);

      if (target) {
        // `verifying` is passed through rather than skipped so the record shows
        // that a verification happened, not just that a status changed.
        for (const step of ["verifying", target] as const) {
          const verdict = mayTransition("verifier", status, step);
          if (!verdict.ok) {
            // A legal-transition failure here means the issue was in a state
            // the verifier cannot act on, which is information, not an error.
            history.push({
              at: now,
              from: status,
              to: status,
              by: "verifier",
              note: verdict.reason,
            });
            break;
          }
          history.push({
            at: now,
            from: status,
            to: step,
            by: "verifier",
            note: outcomeSummary(verification.outcome),
          });
          status = step;
        }
      }

      const updated: Issue = {
        ...issue,
        status,
        updatedAt: now,
        history,
        verifications: [...(issue.verifications ?? []), verification],
        ...(issue.claims
          ? {
              claims: issue.claims.map((claim) =>
                claim.verifiedAt
                  ? claim
                  : {
                      ...claim,
                      verifiedAt: now,
                      outcome: verification.outcome,
                    },
              ),
            }
          : {}),
      };

      store.write(updated);
      if (updated.status === "resolved") resolved.push(issue.id);
      verified.push({
        id: issue.id,
        outcome: verification.outcome,
        status: updated.status,
        summary: outcomeSummary(verification.outcome),
        evidence: verification.evidence,
      });
    }

    store.flush();
    return { verified, resolved };
  }

  /**
   * Select issues for a tracker, and remember that they went.
   *
   * The selection is the interesting half. Neither Linear's CSV import nor
   * `gh issue create` can tell that `UX-0002` is already in the tracker, so a
   * second export duplicates everything unless Drumlin remembers — which makes
   * `record` the difference between a usable command and a command you run
   * once and then never trust.
   */
  protected issuesExport(params: IssuesExportParams): IssuesExportResult {
    const app = resolveAppFor(params);
    const paths = repoPaths(app.root);
    if (!existsSync(paths.dir)) {
      throw new Error(
        "No .drumlin/ directory, so there are no issue ids to export. " +
          "Run `drumlin init`, then `drumlin check`.",
      );
    }

    const store = new IssueStore(app.root);
    const skipped = { alreadyExported: 0, accepted: 0, closed: 0 };
    const selected: Issue[] = [];

    for (const issue of store.list()) {
      if (issue.status === "accepted" && !params.includeAccepted) {
        skipped.accepted += 1;
        continue;
      }
      if (
        (issue.status === "resolved" || issue.status === "superseded") &&
        !params.includeClosed
      ) {
        skipped.closed += 1;
        continue;
      }
      if (
        params.onlyNew &&
        (issue.exports ?? []).some((entry) => entry.target === params.target)
      ) {
        skipped.alreadyExported += 1;
        continue;
      }
      selected.push(issue);
    }

    if (!params.record || selected.length === 0) {
      return { issues: selected, skipped, recorded: false };
    }

    const at = new Date().toISOString();
    const recorded = selected.map((issue) => {
      const updated: Issue = {
        ...issue,
        exports: [...(issue.exports ?? []), { target: params.target, at }],
      };
      store.write(updated);
      return updated;
    });
    store.flush();

    return { issues: recorded, skipped, recorded: true };
  }

  /**
   * Snapshot what was already wrong.
   *
   * Everything the session loop does rests on this: without a baseline, the
   * first `stop` would hand the agent every pre-existing finding in the
   * repository and ask it to account for them.
   */
  protected async sessionStart(
    params: SessionStartParams,
  ): Promise<SessionStartResult> {
    const app = resolveAppFor(params);
    const run = await this.checkRun({ ...params, changed: undefined });

    const store = new SessionStore();
    const session = store.start({
      ...(params.sessionId ? { id: params.sessionId } : {}),
      root: app.root,
      startedAt: new Date().toISOString(),
      ...(params.label ? { label: params.label } : {}),
      baseline: run.findings.map((finding) => findingFingerprint(finding)),
    });

    const status = this.workspaceStatus(params);
    return {
      sessionId: session.id,
      baseline: session.baseline.length,
      warm: status.warm,
    };
  }

  protected sessionTouch(params: SessionTouchParams): SessionTouchResult {
    const store = new SessionStore();
    const files = params.files.filter((file) => isAnalyzableSource(file));
    const session = store.touch(
      params.sessionId,
      files,
      new Date().toISOString(),
    );

    return {
      recorded: session ? files.length : 0,
      totalChanged: session?.changed.length ?? 0,
    };
  }

  /**
   * What this session introduced.
   *
   * Three filters, each removing a different kind of noise, because a
   * `followup_message` spends a whole agent turn and a wrong one derails work
   * rather than being ignored in a list:
   *
   * - **Fingerprint identity** separates a finding the session caused from one
   *   that was already on record. Without it the first `stop` hands the agent
   *   the entire backlog.
   * - **Attribution** separates the agent's work from everything else
   *   happening in the repository. `sessionStart` snapshots once, so a file the
   *   developer hand-typed mid-turn produces a finding the baseline has never
   *   seen — and blaming the agent for it is both wrong and unfixable by the
   *   agent, which is the worst combination.
   * - **The grace window** withholds a finding about a file written moments
   *   ago, for the case where a component and its error boundary arrive as two
   *   separate edits.
   */
  protected async sessionDiff(
    params: SessionDiffParams,
  ): Promise<SessionDiffResult> {
    const store = new SessionStore();
    const session = store.read(params.sessionId);

    if (!session) {
      return {
        introduced: [],
        preexisting: 0,
        graceWithheld: 0,
        elsewhere: 0,
        changedFiles: [],
        hadBaseline: false,
      };
    }

    const app = resolveAppFor({ ...params, root: session.root });
    const run = await this.checkRun({
      ...params,
      root: session.root,
      changed: undefined,
    });
    const view = new GraphView(run.graph);

    const baseline = new Set(session.baseline);
    const threshold = params.severity ? severityRank(params.severity) : 0;
    const windowMs = params.graceMs ?? GRACE_WINDOW_MS;
    const now = Date.now();

    // Only narrow by attribution when the session actually recorded edits.
    // An empty list is ambiguous — the turn may have written nothing, or
    // `afterFileEdit` may simply not have fired, which happens whenever an
    // agent writes through a terminal command. Treating ambiguity as "nothing
    // is attributable" would silently disable the feedback loop, so the
    // fingerprint diff stands alone and `attributed` records which happened.
    const cone =
      session.changed.length > 0
        ? dependentCone(
            run.graph.imports,
            session.changed
              .map((file) => relativePath(app.root, file))
              .filter((file) => !file.startsWith("..")),
          )
        : undefined;

    const introduced: Finding[] = [];
    let preexisting = 0;
    let graceWithheld = 0;
    let elsewhere = 0;

    for (const finding of run.findings) {
      if (baseline.has(findingFingerprint(finding))) {
        preexisting += 1;
        continue;
      }
      if (severityRank(finding.severity) < threshold) continue;
      if (cone && attributeFindings([finding], cone, view).elsewhere.length > 0) {
        elsewhere += 1;
        continue;
      }
      if (
        withinGraceWindow(
          finding,
          session.touchedAt,
          app.root,
          view,
          now,
          windowMs,
        )
      ) {
        graceWithheld += 1;
        continue;
      }
      introduced.push(finding);
    }

    if (params.absorb === true && introduced.length > 0) {
      store.absorb(
        params.sessionId,
        introduced.map((finding) => findingFingerprint(finding)),
      );
    }

    return {
      introduced,
      preexisting,
      graceWithheld,
      elsewhere,
      attributed: cone !== undefined,
      changedFiles: session.changed.map((file) => relativePath(app.root, file)),
      hadBaseline: true,
    };
  }

  protected sessionEnd(params: SessionEndParams): SessionEndResult {
    return { closed: new SessionStore().end(params.sessionId) };
  }

  protected issuesList(params: IssuesListParams): IssuesListResult {
    const app = resolveAppFor(params);
    const store = new IssueStore(app.root);
    const wanted = new Set(params.status ?? []);
    const issues = store
      .list()
      .filter((issue) => wanted.size === 0 || wanted.has(issue.status));
    return { issues };
  }

  protected workspaceOpen(params: WorkspaceOpenParams): WorkspaceOpenResult {
    return { app: resolveAppFor(params) };
  }

  /**
   * What state this workspace is in.
   *
   * In-process there is nothing warm and no revision to report, and saying so
   * plainly is the point: a client that cannot tell a cold CLI from a daemon
   * will eventually blame the rules for a graph it never rebuilt.
   */
  protected workspaceStatus(
    params: WorkspaceStatusParams,
  ): WorkspaceStatusResult {
    const app = resolveAppFor(params);
    return {
      root: app.root,
      app,
      warm: false,
      revision: 0,
      pendingFiles: 0,
      persisted: existsSync(repoPaths(app.root).dir),
    };
  }

  protected async graphGet(params: GraphGetParams): Promise<GraphGetResult> {
    const app = resolveAppFor(params);
    // Caching requires `.drumlin/`, and creating it is `drumlin init`'s job
    // alone. Otherwise a read-only command leaves a directory behind and
    // silently opts the repository in to persistence it never asked for.
    const useCache = params.cache !== false && existsSync(repoPaths(app.root).dir);

    const key = computeCacheKey({
      directories: [app.appDir, app.pagesDir, app.root].filter(
        (dir): dir is string => dir !== undefined,
      ),
      salt: [app.root, app.router],
    });

    let cache: DerivedCache | undefined;
    try {
      if (useCache) {
        cache = await DerivedCache.open(repoPaths(app.root).cacheDbFile);
        const hit = cache.getGraph(key);
        if (hit) {
          return {
            graph: hit,
            stats: cachedStats(hit),
            brokenLinks: [],
            cached: true,
          };
        }
      }

      const result: IndexResult = indexApp({ root: app.root, app });
      cache?.putGraph(key, result.graph);
      return {
        graph: result.graph,
        stats: result.stats,
        brokenLinks: result.brokenLinks,
        cached: false,
      };
    } finally {
      cache?.close();
    }
  }
}

/**
 * Resolve the app to work on.
 *
 * An explicit `--app` is treated as the app root directly. Without one,
 * discovery runs and refuses to guess when a monorepo holds several apps,
 * because analyzing the wrong one produces a report that looks plausible and
 * describes a different product.
 */
export function resolveAppFor(params: WorkspaceOpenParams): NextApp {
  if (params.app) {
    const app = describeApp(params.app);
    if (!app) {
      throw new Error(
        `${params.app} has no app/ or pages/ directory. ` +
          `Point --app at the directory containing next.config.*`,
      );
    }
    return app;
  }
  return resolveApp({ root: params.root });
}

/**
 * Route prefixes that group several screens.
 *
 * Orientation, not analysis: an agent asking what this app is wants "there are
 * 14 screens under /admin", not a list of 89 routes it has to read.
 */
function routeSections(view: GraphView): Array<{ prefix: string; screens: number }> {
  const counts = new Map<string, number>();

  for (const screen of view.screens) {
    if (!screen.route) continue;
    const segments = withoutLocaleSegments(screen.route)
      .split("/")
      .filter((segment) => segment.length > 0);
    const first = segments[0];
    // A dynamic first segment is a catch-all, not a section anyone navigates.
    if (!first || first.startsWith("[")) continue;
    counts.set(first, (counts.get(first) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, screens]) => screens > 1)
    .map(([prefix, screens]) => ({ prefix: `/${prefix}`, screens }))
    .sort((a, b) => b.screens - a.screens || a.prefix.localeCompare(b.prefix))
    .slice(0, 20);
}

/**
 * Accept `UX-7`, `ux-0007`, and `7` as the same issue.
 *
 * A developer reading `UX-0007` off a report and typing `UX-7` should not get
 * "no such issue".
 */
function normalizeIssueId(id: string): string {
  const trimmed = id.trim();
  const match = /^(?:ux-)?0*(\d+)$/i.exec(trimmed);
  if (!match?.[1]) return trimmed;
  return issueId(Number.parseInt(match[1], 10));
}

/**
 * Why an id did not resolve to an issue.
 *
 * This used to be `No issue ${id}. Run \`drumlin check\` to see what exists`,
 * which is a circle in the case that produces it most often. `check` runs
 * without `.drumlin/` and prints real `UX-` ids; nothing stores them. So a
 * newcomer reads an id off `check`, passes it to `accept`, and is told to run
 * the command they just ran.
 *
 * The absent directory is the whole answer, so say that instead. Shared by
 * every command that takes an id — accept, revoke, propose, decline, claim,
 * verify — because they all reach it the same way and the diagnosis does not
 * depend on which one asked.
 */
function missingIssue(root: string, id: string): Error {
  if (!existsSync(repoPaths(root).dir)) {
    return new Error(
      `No issue ${id} on record. This project has no .drumlin/, so findings ` +
        `are reported but never kept, and the ids \`drumlin check\` printed ` +
        `do not outlive it. Run \`drumlin init\` here, then \`drumlin check\`.`,
    );
  }

  return new Error(
    `No issue ${id}. Run \`drumlin check\` to see what is currently on record.`,
  );
}

/**
 * How long after an edit a finding about that file is withheld.
 *
 * Long enough to cover an agent writing a component in several passes, short
 * enough that a genuine problem still surfaces in the same turn.
 */
/**
 * How recently a file must have been written to earn silence. Off by default.
 *
 * This started at 20 seconds and is worth recording as a wrong turn, because
 * the reasoning was plausible: half-written code legitimately has no error
 * state, so reporting it mid-edit would be noise. The plan anticipated needing
 * exactly this.
 *
 * Measuring it against real turns showed the mechanism misfires at the only
 * place it is wired. `stop` fires seconds after the agent's last write —
 * always, by construction — so any non-trivial window withholds every finding
 * the turn introduced. Dropping to 3 seconds did not fix it; a real regression
 * still came back as `graceWithheld: 1, introduced: 0`, which is a loop that
 * has switched itself off while reporting success.
 *
 * The premise was wrong rather than the number. Grace assumes the code is
 * still being written, and at `stop` the agent has declared it finished. A
 * component left without an error state at the end of a turn is the finding,
 * not a false positive.
 *
 * The mechanism stays, parameterised, for a caller that does report mid-edit —
 * a future editor surface would need it. Nothing at Milestone B does.
 */
const GRACE_WINDOW_MS = 0;

function withinGraceWindow(
  finding: Finding,
  touchedAt: Record<string, string>,
  root: string,
  view: GraphView,
  now: number,
  windowMs: number,
): boolean {
  if (windowMs <= 0) return false;

  // Via findingFiles, so a graph-classified finding resolves through its
  // target node. Re-deriving the file list here is how `flow.orphan` ends up
  // exempt from a rule that was meant to apply to every finding.
  const files = findingFiles(finding, view);
  if (files.size === 0) return false;

  for (const [absolute, at] of Object.entries(touchedAt)) {
    if (!files.has(relativePath(root, absolute))) continue;
    if (now - Date.parse(at) < windowMs) return true;
  }
  return false;
}

/**
 * Stats for a cached graph.
 *
 * A cache hit did no work, so the counts are recovered from the document and
 * the durations are zero. Reporting the original run's timings would be a lie
 * about what just happened.
 */
function cachedStats(graph: GraphDocument): GraphGetResult["stats"] {
  const count = (type: string): number =>
    graph.nodes.filter((node) => node.type === type).length;
  return {
    filesParsed: 0,
    screens: count("Screen"),
    states: count("State"),
    actions: count("Action"),
    components: count("Component"),
    edges: graph.edges.length,
    durationMs: 0,
  };
}
