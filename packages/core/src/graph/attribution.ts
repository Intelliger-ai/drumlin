import type { Finding, ModuleGraph } from "@drumlin/model";
import type { GraphView } from "./view.js";

/**
 * Attributing findings to a change.
 *
 * The load-bearing correction of Milestone B, recorded as DEC-0003: this
 * narrows the *report*, never the analysis. Reachability is a whole-graph
 * property — a screen becomes an orphan because a link vanished somewhere else
 * entirely — so running the rules over a dependency cone would quietly stop
 * `flow.orphan` and `flow.dead-end` from ever firing again, and the output
 * would look healthier for it.
 *
 * So every rule sees the whole graph, and this decides what is worth showing.
 */

/**
 * The changed files plus everything that transitively imports them.
 *
 * Importers, not imports: editing a shared `Sidebar` affects every screen that
 * renders it, while the icon library the sidebar imports is unaffected.
 */
export function dependentCone(
  imports: ModuleGraph | undefined,
  changed: Iterable<string>,
): Set<string> {
  const cone = new Set<string>(changed);
  if (!imports) return cone;

  const importers = new Map<string, string[]>();
  for (const [file, targets] of Object.entries(imports)) {
    for (const target of targets) {
      const bucket = importers.get(target);
      if (bucket) bucket.push(file);
      else importers.set(target, [file]);
    }
  }

  const queue = [...cone];
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const importer of importers.get(file) ?? []) {
      if (cone.has(importer)) continue;
      cone.add(importer);
      queue.push(importer);
    }
  }

  return cone;
}

/**
 * Every file a finding points at.
 *
 * Evidence locations are the direct answer, but they are not the whole one.
 * A graph-classified finding cites nodes rather than lines — an orphan's
 * evidence is "nothing links to this screen", which has no file of its own —
 * and a route-section rollup cites eight routes while carrying source
 * locations for one or two of them. Resolving graph references back to their
 * source files is what keeps both kinds attributable.
 *
 * References are resolved as either node ids or routes, because findings use
 * both and the difference is not visible in the string.
 */
export function findingFiles(finding: Finding, view: GraphView): Set<string> {
  const files = new Set<string>();

  const addSourcesOf = (ref: string | undefined): void => {
    if (!ref) return;
    for (const node of view.resolve(ref)) {
      for (const source of node.sources ?? []) {
        if (source.file) files.add(source.file);
      }
    }
  };

  for (const evidence of finding.evidence) {
    if (evidence.location?.file) files.add(evidence.location.file);
    // The rollup case: the affected screens are named in evidence refs, and
    // dropping them means editing seven of eight screens in a section
    // attributes nothing.
    if (evidence.type === "graph" && evidence.ref) addSourcesOf(evidence.ref);
  }

  if (finding.target.file) files.add(finding.target.file);
  if (finding.target.route) addSourcesOf(finding.target.route);

  addSourcesOf(finding.target.node);
  addSourcesOf(finding.target.from);
  addSourcesOf(finding.target.to);
  addSourcesOf(finding.target.via);

  return files;
}

export interface AttributionResult {
  attributed: Finding[];
  /** Findings that exist but belong to code this change did not touch. */
  elsewhere: Finding[];
}

/**
 * Split findings by whether the change could plausibly have caused them.
 *
 * A finding with no resolvable file is treated as attributed rather than
 * dropped. Being unable to place a problem is a reason to show it, not a
 * reason to hide it — silently withholding findings is how a tool loses the
 * developer's trust for good.
 */
export function attributeFindings(
  findings: readonly Finding[],
  cone: ReadonlySet<string>,
  view: GraphView,
): AttributionResult {
  const attributed: Finding[] = [];
  const elsewhere: Finding[] = [];

  for (const finding of findings) {
    const files = findingFiles(finding, view);
    if (files.size === 0) {
      attributed.push(finding);
      continue;
    }
    if ([...files].some((file) => cone.has(file))) attributed.push(finding);
    else elsewhere.push(finding);
  }

  return { attributed, elsewhere };
}
