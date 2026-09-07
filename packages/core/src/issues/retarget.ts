import {
  findingFingerprint,
  type FindingTarget,
  type Issue,
  type NodeId,
} from "@drumlin/model";
import type { IdentityMatch } from "../graph/identity.js";
import { renameMap } from "../graph/identity.js";

/**
 * Carrying issues across a rename.
 *
 * This is why [[Graph Identity]] matters and is not an academic exercise. An
 * issue's fingerprint is `ruleId|node:screen.invoices`, so renaming the route
 * `/invoices` to `/bills` changes the fingerprint, and `reconcile` — which
 * matches purely on fingerprint — sees the old issue vanish and a brand new
 * one appear. The `UX-` number is retired, a fresh one is minted, and any
 * acceptance decision on the old one is left behind on an issue nothing will
 * ever report again.
 *
 * The observable bug is the worst kind: a developer renames a route, and
 * findings they had deliberately accepted come back as new. They have no way
 * to connect the two events, so the conclusion available to them is that
 * accepting does not work.
 *
 * Applied before `reconcile`, so by the time fingerprints are compared they
 * already speak the new graph's language.
 */

export interface RetargetResult {
  issues: Issue[];
  /** One entry per issue whose target moved, for reporting what happened. */
  moved: Array<{ id: string; from: string; to: string }>;
}

/**
 * Rewrite issue targets and fingerprints through a graph match.
 *
 * Only renames are applied. An added or removed node needs no rewriting, and
 * an *ambiguous* candidate is deliberately ignored: retargeting an accepted
 * issue onto the wrong node would silence a real finding somewhere nobody is
 * looking, which is strictly worse than losing a number.
 */
export function retargetIssues(
  issues: readonly Issue[],
  match: IdentityMatch,
): RetargetResult {
  return retargetByMap(issues, renameMap(match));
}

export function retargetByMap(
  issues: readonly Issue[],
  renames: ReadonlyMap<NodeId, NodeId>,
): RetargetResult {
  if (renames.size === 0) return { issues: [...issues], moved: [] };

  const moved: RetargetResult["moved"] = [];

  const issuesOut = issues.map((issue) => {
    const target = retargetTarget(issue.target, renames);
    if (!target) return issue;

    // Recomputed rather than string-substituted. The fingerprint format is
    // `targetKey`'s business, and a rename that happens to produce a
    // substring collision would corrupt an unrelated id.
    const fingerprint = findingFingerprint({
      ruleId: issue.rule.id,
      target,
    } as Parameters<typeof findingFingerprint>[0]);

    moved.push({ id: issue.id, from: issue.fingerprint, to: fingerprint });

    return { ...issue, target, fingerprint };
  });

  return { issues: issuesOut, moved };
}

/** Returns undefined when nothing in the target was renamed. */
function retargetTarget(
  target: FindingTarget,
  renames: ReadonlyMap<NodeId, NodeId>,
): FindingTarget | undefined {
  switch (target.kind) {
    case "node": {
      const node = target.node ? renames.get(target.node) : undefined;
      return node ? { ...target, node } : undefined;
    }
    case "edge": {
      // Every endpoint independently, because a transition survives one of its
      // screens being renamed and both being renamed equally well.
      const from = target.from ? renames.get(target.from) : undefined;
      const to = target.to ? renames.get(target.to) : undefined;
      const via = target.via ? renames.get(target.via) : undefined;
      if (!from && !to && !via) return undefined;
      return {
        ...target,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(via ? { via } : {}),
      };
    }
    // A route target keys on the URL, and a file target on a path. Neither is
    // a node id, so the node rename map says nothing about them — a route that
    // changed is a different route, and treating it otherwise would be
    // guessing outside this function's evidence.
    case "route":
    case "file":
    case "project":
      return undefined;
  }
}
