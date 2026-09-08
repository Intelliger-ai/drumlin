import { GraphView, MILESTONE_A_RULES } from "@drumlin/core";
import {
  isConfirmed,
  type Issue,
  type NodeId,
  type PermissionsDocument,
} from "@drumlin/model";
import { flowFor } from "./flow.js";
import type { IssuePacket } from "./types.js";

/**
 * Assembling an issue packet.
 *
 * The field list is from Context/11 and Context/12. The discipline is that
 * every field is either a fact the repository supports or absent — an agent
 * given an invented actor and a plausible-sounding goal will act on them, and
 * cannot tell them apart from the graph facts sitting next to them.
 *
 * So `actor` appears only behind a human-confirmed permissions model, and the
 * target behaviour is the rule's own proposal rather than a description
 * generated for the occasion.
 */

export interface PacketInput {
  issue: Issue;
  view: GraphView;
  issues: readonly Issue[];
  /** Passed through to the re-test command when the repo holds several apps. */
  appFlag?: string;
  permissions?: PermissionsDocument;
}

export function buildPacket(input: PacketInput): IssuePacket {
  const { issue, view } = input;

  const screenId = screenFor(issue, view);
  const neighbourhood = screenId
    ? safeFlow(view, screenId, input.issues)
    : undefined;

  // Deduplicated: a route-section rollup merges one criterion per affected
  // screen, so an eight-screen finding arrives with the same sentence eight
  // times. Repetition reads as sloppiness and spends the agent's context on
  // nothing.
  const acceptance = unique(issue.acceptance ?? []);

  const packet: IssuePacket = {
    issue,
    currentBehaviour: issue.message,
    acceptance: acceptance.length > 0 ? acceptance : fallbackAcceptance(issue),
    constraints: constraintsFor(issue, view, screenId),
    likelyFiles: likelyFiles(issue, view, screenId),
    primitives: primitivesFor(view),
    retestCommand: retestCommand(issue, input.appFlag),
  };

  if (issue.proposal) packet.targetBehaviour = issue.proposal;
  if (neighbourhood) packet.neighbourhood = neighbourhood;

  const actor = actorFor(view, screenId, input.permissions);
  if (actor) packet.actor = actor;

  return packet;
}

/**
 * The screen a packet is about.
 *
 * Route-scoped findings are included, and have to be: `state.route.no-error`
 * targets a section rather than a node, and skipping those left every rollup
 * issue with no neighbourhood and no constraints — the two fields that tell
 * the agent what it must not break.
 *
 * A section maps to a representative screen rather than to all of them. The
 * neighbourhood of eight screens at once is not a neighbourhood.
 */
function screenFor(issue: Issue, view: GraphView): NodeId | undefined {
  const refs = [
    issue.target.node,
    issue.target.route,
    issue.target.from,
    issue.target.to,
    // Rollups name their affected screens here and nowhere else.
    ...issue.evidence
      .filter((item) => item.type === "graph")
      .map((item) => item.ref),
  ].filter((ref): ref is string => ref !== undefined);

  for (const ref of refs) {
    for (const node of view.resolve(ref)) {
      if (node.type === "Screen") return node.id;
      // A finding on a state or an action is still about the screen holding it.
      const owner = view
        .incoming(node.id)
        .find((edge) => edge.type === "contains");
      const parent = owner ? view.node(owner.from) : undefined;
      if (parent?.type === "Screen") return parent.id;
    }
  }
  return undefined;
}

function safeFlow(
  view: GraphView,
  screenId: NodeId,
  issues: readonly Issue[],
): IssuePacket["neighbourhood"] {
  try {
    return flowFor(view, screenId, issues);
  } catch {
    // A packet without a neighbourhood is still useful; refusing to produce
    // one because the graph moved under us is not.
    return undefined;
  }
}

/**
 * What the fix must not break.
 *
 * Read off the graph rather than written as advice. "Preserve the `status` and
 * `region` search params" is checkable; "be careful with state" is not, and an
 * agent cannot act on it.
 */
function constraintsFor(
  issue: Issue,
  view: GraphView,
  screenId: NodeId | undefined,
): string[] {
  const constraints: string[] = [];
  const screen = screenId ? view.node(screenId) : undefined;

  if (screen) {
    const properties = screen.properties ?? {};

    const keys = properties["searchParamKeys"];
    if (Array.isArray(keys) && keys.length > 0) {
      constraints.push(
        `This screen reads the search params ${keys.join(", ")}. They must survive the fix.`,
      );
    }
    if (properties["prerendered"] === true) {
      constraints.push(
        "Statically generated at build time, so it has no request-time loading state to add.",
      );
    }
    if (properties["clientComponent"] === true) {
      constraints.push(
        "A client component: server-only APIs are unavailable here.",
      );
    }
    if (screen.router) {
      constraints.push(
        `Lives in the ${screen.router === "app" ? "App" : "Pages"} Router, so use that router's conventions.`,
      );
    }

    for (const action of view.actionsOf(screen.id)) {
      if (action.context?.destructive !== true) continue;
      const hasConfirmation = action.properties?.["hasConfirmation"] === true;
      if (hasConfirmation) {
        constraints.push(
          `\`${action.label ?? action.id}\` is destructive and already confirms. Keep the confirmation.`,
        );
      }
    }
  }

  if (issue.status === "accepted") {
    constraints.push(
      "A human accepted this deviation. Do not change it without asking them.",
    );
  }

  return constraints;
}

/**
 * Where to start reading.
 *
 * Ordered by how specific the pointer is: a rule that cited a line knows more
 * than the screen's own file does.
 */
function likelyFiles(
  issue: Issue,
  view: GraphView,
  screenId: NodeId | undefined,
): string[] {
  const ordered: string[] = [];
  const add = (file: string | undefined): void => {
    if (file && !ordered.includes(file)) ordered.push(file);
  };
  const addSourcesOf = (ref: string | undefined): void => {
    if (!ref) return;
    for (const node of view.resolve(ref)) {
      for (const source of node.sources ?? []) add(source.file);
    }
  };

  // Cited locations first, then everything the finding merely refers to.
  for (const evidence of issue.evidence) add(evidence.location?.file);
  add(issue.target.file);

  // A route-section rollup names its affected screens as graph refs and
  // carries locations for only one or two. Without this, a finding about eight
  // screens hands the agent two files and it edits the wrong section.
  for (const evidence of issue.evidence) {
    if (evidence.type === "graph") addSourcesOf(evidence.ref);
  }
  addSourcesOf(issue.target.route);
  addSourcesOf(issue.target.node);
  addSourcesOf(issue.target.from);
  addSourcesOf(issue.target.to);
  addSourcesOf(screenId);

  return ordered;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Design-system components already in the codebase.
 *
 * The single most common way an agent makes a UX problem worse is by writing a
 * new button rather than using the one already there — which is what
 * `component.duplicate-primitive` fires on. Naming the primitives up front is
 * cheaper than reporting the duplicate afterwards.
 */
function primitivesFor(view: GraphView): string[] {
  const names = new Set<string>();
  for (const component of view.nodesOfType("Component")) {
    if (component.properties?.["designSystem"] !== true) continue;
    names.add(component.label ?? component.id);
  }
  return [...names].sort().slice(0, 40);
}

function actorFor(
  view: GraphView,
  screenId: NodeId | undefined,
  permissions: PermissionsDocument | undefined,
): string | undefined {
  if (!permissions || !isConfirmed(permissions)) return undefined;
  if (!screenId) return undefined;
  const roles = view.node(screenId)?.context?.roles;
  return roles && roles.length > 0 ? roles.join(", ") : undefined;
}

/**
 * The command that re-tests this issue.
 *
 * Named in the packet because the alternative is the agent inventing a way to
 * check its own work. At Milestone B this proves only that the rule no longer
 * fires, which is not the same as the flow working — that distinction is what
 * Milestone C's verifier exists to close.
 */
function retestCommand(issue: Issue, appFlag: string | undefined): string {
  const parts = ["drumlin check", `--rule ${issue.rule.id}`];
  if (appFlag) parts.push(`--app ${appFlag}`);
  return parts.join(" ");
}

function fallbackAcceptance(issue: Issue): string[] {
  const rule = MILESTONE_A_RULES.find(
    (candidate) => candidate.id === issue.rule.id,
  );
  return rule
    ? [`\`${rule.id}\` no longer reports this target: ${rule.summary}`]
    : [`\`${issue.rule.id}\` no longer reports this target.`];
}
