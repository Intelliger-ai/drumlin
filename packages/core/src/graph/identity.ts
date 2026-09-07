import {
  slugify,
  routeSegments,
  type GraphDocument,
  type NodeId,
  type NodeType,
} from "@drumlin/model";

/**
 * Matching a freshly extracted graph onto an older one.
 *
 * Node ids are semantic, which is what makes them readable, and derived, which
 * is what makes them fragile. `screen.invoices` comes from the route, so
 * renaming `/invoices` to `/bills` produces `screen.bills` — a different id for
 * the same screen. `component.src-ui-table.tsx.Table` embeds a file path, so
 * moving the file renames the node. And `action.approve` becomes
 * `action.src-lib-a.ts.approve` the moment a second `approve` appears anywhere
 * in the repository, which means an unrelated file can rename an existing node.
 *
 * Without a resolver, every one of those reads as one node deleted and another
 * added. That is not a cosmetic problem, because issue identity is built on
 * node identity: a finding's fingerprint is `ruleId|node:screen.invoices`, so a
 * route rename retires the `UX-` number, mints a fresh one, and drops any
 * acceptance decision attached to it. A developer who renames a route gets
 * their accepted deviations silently un-accepted.
 *
 * ## Why weighted rather than a better id scheme
 *
 * The tempting fix is a more stable id — hash the symbol, or make the developer
 * declare one. Neither works. A hash is not readable, and the whole argument
 * for semantic ids is that `screen.invoices` in a commit message means
 * something. Declared ids put the burden on the person least likely to
 * anticipate the rename. And no id scheme survives the real case, which is a
 * screen that changed route *and* moved file *and* got renamed in one commit.
 *
 * So identity is reconstructed from evidence, with the reconstruction visible:
 * every match records which signals agreed, so a wrong one can be understood
 * rather than just observed.
 *
 * ## Why it refuses more than it guesses
 *
 * A wrong match is worse than no match. Reporting one node added and one
 * removed loses a `UX-` number, which is annoying. Matching the wrong pair
 * moves an accepted issue onto a different screen, which silences a real
 * finding somewhere nobody is looking. So the thresholds are set to prefer
 * add-plus-remove, and an ambiguous best candidate is rejected outright rather
 * than resolved by tie-break.
 */

/**
 * The identity-bearing projection of a node.
 *
 * Deliberately small and separate from `GraphNode`. It is what gets persisted
 * as a baseline, so it has to stay cheap to store and stable to compare —
 * carrying `properties` into it would mean a line number in `unboundedSelects`
 * counted as identity.
 */
export interface IdentityNode {
  id: NodeId;
  type: NodeType;
  route?: string;
  stateKind?: string;
  label?: string;
  /** Enclosing symbols from `sources`. More stable than the file holding them. */
  symbols: string[];
  /** Repository-relative files. Evidence, per Stable IDs — never identity alone. */
  files: string[];
  /** Undirected neighbour ids, for structural comparison. */
  neighbours: NodeId[];
}

export interface GraphIdentitySnapshot {
  schemaVersion: number;
  generatedAt?: string;
  commit?: string;
  nodes: IdentityNode[];
}

export const IDENTITY_SCHEMA_VERSION = 1;

export interface IdentityMatchDetail {
  before: NodeId;
  after: NodeId;
  /** 0 to 1. How well the evidence agrees. */
  score: number;
  /** Absolute weight of agreeing signals, which is how thin evidence is caught. */
  support: number;
  /** Which signals agreed, for explaining the match to a human. */
  because: string[];
}

export interface IdentityMatch {
  /** Same id in both graphs. The overwhelmingly common case. */
  anchored: IdentityMatchDetail[];
  /** Different id, matched on evidence. These are what need retargeting. */
  renamed: IdentityMatchDetail[];
  /** In the new graph with no counterpart. */
  added: IdentityNode[];
  /** In the old graph with no counterpart. */
  removed: IdentityNode[];
  /**
   * Pairs that scored well but not decisively enough to act on.
   *
   * Surfaced rather than dropped: "this might be a rename and Drumlin would
   * not commit to it" is useful, and silently discarding near-misses is how
   * you fail to notice the thresholds are wrong.
   */
  ambiguous: IdentityMatchDetail[];
}

export interface IdentityWeights {
  route: number;
  symbol: number;
  file: number;
  stateKind: number;
  label: number;
  neighbourhood: number;
}

/**
 * Relative trust in each signal.
 *
 * `neighbourhood` leads, which is not where this started. The first version
 * ranked it fourth on the intuition that concrete attributes beat inferred
 * structure, and it could not match a renamed route — the case the resolver
 * mainly exists for. The reason is structural: a screen has no symbol, so when
 * its route changes the only attributes left are the route that just changed
 * and a path that changed with it. Every attribute signal disagrees, correctly,
 * and the match has to be carried by the observation that the same actions and
 * the same inbound screens are still attached to it. If structure cannot
 * outvote a route rename, route renames are undetectable.
 *
 * Below that, `symbol` beats `file` because renaming a function is rarer than
 * moving the file holding it, and `route` beats `file` because a route is a
 * user-facing contract while a path is an implementation detail. `label` is
 * nearly worthless alone — display text the model explicitly declines to treat
 * as identity — but it breaks ties honestly.
 */
export const DEFAULT_IDENTITY_WEIGHTS: IdentityWeights = {
  neighbourhood: 0.42,
  symbol: 0.34,
  route: 0.3,
  file: 0.2,
  stateKind: 0.12,
  label: 0.1,
};

export interface IdentityThresholds {
  /** Minimum normalised agreement. */
  score: number;
  /** Minimum absolute weight of agreeing signals. */
  support: number;
  /**
   * How far the best candidate must beat the runner-up.
   *
   * Two screens that both plausibly became `/bills` is a case where the honest
   * answer is "I do not know", not the one that scored 0.01 higher.
   */
  margin: number;
}

export const DEFAULT_IDENTITY_THRESHOLDS: IdentityThresholds = {
  score: 0.58,
  support: 0.3,
  margin: 0.08,
};

export interface MatchOptions {
  weights?: Partial<IdentityWeights>;
  thresholds?: Partial<IdentityThresholds>;
  /**
   * How many times structural similarity is fed back in.
   *
   * One pass matches on attributes alone; each further pass lets confirmed
   * matches vouch for their neighbours, which is what carries a renamed screen
   * whose own attributes all changed. Two is enough in practice — propagation
   * past that mostly reinforces what it already decided.
   */
  passes?: number;
}

/** Project a graph document down to what identity is allowed to depend on. */
export function identityNodes(graph: GraphDocument): IdentityNode[] {
  const neighbours = new Map<NodeId, Set<NodeId>>();
  const link = (a: NodeId, b: NodeId): void => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };

  for (const edge of graph.edges) {
    // Undirected on purpose. Which way a `contains` edge points is a fact
    // about the schema; for "is this the same node", being adjacent is the
    // signal, and direction only halves the evidence.
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  return graph.nodes
    .map((node) => {
      const symbols = new Set<string>();
      const files = new Set<string>();
      for (const source of node.sources ?? []) {
        if (source.symbol) symbols.add(source.symbol);
        if (source.file) files.add(source.file);
      }

      // A label that merely restates the route is not a second signal. The
      // indexer sets `label` to the route for every screen, so counting both
      // weighs one fact twice — and because a route rename makes that fact
      // disagree, it was double-penalising the exact case this resolver
      // exists to catch. Dropping it also keeps the persisted baseline
      // smaller.
      const label = node.label === node.route ? undefined : node.label;

      return {
        id: node.id,
        type: node.type,
        ...(node.route ? { route: node.route } : {}),
        ...(node.stateKind ? { stateKind: node.stateKind } : {}),
        ...(label ? { label } : {}),
        symbols: [...symbols],
        files: [...files],
        neighbours: [...(neighbours.get(node.id) ?? [])].sort(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function identitySnapshot(
  graph: GraphDocument,
  meta: { generatedAt?: string; commit?: string } = {},
): GraphIdentitySnapshot {
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    ...(meta.generatedAt ? { generatedAt: meta.generatedAt } : {}),
    ...(meta.commit ? { commit: meta.commit } : {}),
    nodes: identityNodes(graph),
  };
}

export function matchGraphs(
  before: GraphDocument | GraphIdentitySnapshot,
  after: GraphDocument | GraphIdentitySnapshot,
  options: MatchOptions = {},
): IdentityMatch {
  return matchIdentities(nodesOf(before), nodesOf(after), options);
}

export function matchIdentities(
  before: readonly IdentityNode[],
  after: readonly IdentityNode[],
  options: MatchOptions = {},
): IdentityMatch {
  const weights = { ...DEFAULT_IDENTITY_WEIGHTS, ...options.weights };
  const thresholds = { ...DEFAULT_IDENTITY_THRESHOLDS, ...options.thresholds };
  const passes = Math.max(1, options.passes ?? 2);

  const afterById = new Map(after.map((node) => [node.id, node]));

  // Pass 0: same id, same type. Not scored, because there is nothing to
  // decide — and skipping the scoring is what keeps this affordable on a graph
  // where almost nothing moved.
  const anchored: IdentityMatchDetail[] = [];
  const mapping = new Map<NodeId, NodeId>();

  for (const node of before) {
    const counterpart = afterById.get(node.id);
    if (!counterpart || counterpart.type !== node.type) continue;
    anchored.push({
      before: node.id,
      after: node.id,
      score: 1,
      support: 1,
      because: ["identical id"],
    });
    mapping.set(node.id, node.id);
  }

  const unmatchedBefore = before.filter((node) => !mapping.has(node.id));
  const unmatchedAfter = after.filter((node) => !mapping.has(node.id));

  let renamed: IdentityMatchDetail[] = [];
  let ambiguous: IdentityMatchDetail[] = [];

  for (let pass = 0; pass < passes; pass += 1) {
    // Each pass reconsiders every rename from scratch against the current
    // mapping, rather than adding to the previous pass's decisions. A match
    // made on thin attribute evidence should be allowed to be overturned once
    // structure disagrees with it.
    const working = new Map(
      anchored.map((match) => [match.before, match.after] as const),
    );
    for (const match of renamed) working.set(match.before, match.after);

    const scored = scorePairs(
      unmatchedBefore,
      unmatchedAfter,
      working,
      weights,
      pass > 0,
    );

    const assignment = assign(scored, thresholds);
    renamed = assignment.matched;
    ambiguous = assignment.ambiguous;
  }

  const finalMapping = new Map(mapping);
  for (const match of renamed) finalMapping.set(match.before, match.after);

  const claimed = new Set(finalMapping.values());

  return {
    anchored,
    renamed,
    added: after.filter((node) => !claimed.has(node.id)),
    removed: before.filter((node) => !finalMapping.has(node.id)),
    ambiguous,
  };
}

/** The rename map, for rewriting anything that referenced an old node id. */
export function renameMap(match: IdentityMatch): Map<NodeId, NodeId> {
  return new Map(match.renamed.map((entry) => [entry.before, entry.after]));
}

type Candidate = IdentityMatchDetail;

function scorePairs(
  before: readonly IdentityNode[],
  after: readonly IdentityNode[],
  mapping: ReadonlyMap<NodeId, NodeId>,
  weights: IdentityWeights,
  useStructure: boolean,
): Candidate[] {
  const candidates: Candidate[] = [];
  const byType = new Map<NodeType, IdentityNode[]>();
  for (const node of after) {
    const bucket = byType.get(node.type);
    if (bucket) bucket.push(node);
    else byType.set(node.type, [node]);
  }

  for (const old of before) {
    // A Screen never becomes an Action. Restricting to same-type pairs is both
    // correct and the only reason this stays tractable on a large graph.
    for (const fresh of byType.get(old.type) ?? []) {
      const candidate = score(old, fresh, mapping, weights, useStructure);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}

function score(
  old: IdentityNode,
  fresh: IdentityNode,
  mapping: ReadonlyMap<NodeId, NodeId>,
  weights: IdentityWeights,
  useStructure: boolean,
): Candidate | undefined {
  let weighted = 0;
  let applicable = 0;
  let support = 0;
  const because: string[] = [];

  const consider = (
    weight: number,
    similarity: number | undefined,
    describe: string,
  ): void => {
    if (similarity === undefined) return;
    applicable += weight;
    weighted += weight * similarity;
    // Half agreement is the line for "this signal is evidence" as opposed to
    // "this signal was merely available".
    if (similarity >= 0.5) {
      support += weight;
      because.push(describe);
    }
  };

  consider(weights.symbol, symbolSimilarity(old.symbols, fresh.symbols), "symbol");
  consider(weights.route, routeSimilarity(old.route, fresh.route), "route");
  consider(weights.file, fileSimilarity(old.files, fresh.files), "file");
  consider(
    weights.stateKind,
    exactSimilarity(old.stateKind, fresh.stateKind),
    "state kind",
  );
  consider(weights.label, textSimilarity(old.label, fresh.label), "label");

  if (useStructure) {
    consider(
      weights.neighbourhood,
      neighbourhoodSimilarity(old.neighbours, fresh.neighbours, mapping),
      "neighbourhood",
    );
  }

  if (applicable === 0) return undefined;

  return {
    before: old.id,
    after: fresh.id,
    score: weighted / applicable,
    support,
    because,
  };
}

/**
 * Greedy, highest-scoring first, one-to-one.
 *
 * Not optimal assignment. A Hungarian solve would maximise total score across
 * the whole graph, and would do it by accepting individually worse pairs to
 * improve the sum — which is exactly the wrong trade here, because a
 * confidently correct rename should not be sacrificed to accommodate a
 * doubtful one elsewhere.
 */
function assign(
  candidates: readonly Candidate[],
  thresholds: IdentityThresholds,
): { matched: IdentityMatchDetail[]; ambiguous: IdentityMatchDetail[] } {
  const viable = candidates
    .filter(
      (candidate) =>
        candidate.score >= thresholds.score &&
        candidate.support >= thresholds.support,
    )
    .sort((a, b) => b.score - a.score || a.before.localeCompare(b.before));

  const bestByBefore = new Map<NodeId, Candidate[]>();
  for (const candidate of viable) {
    const bucket = bestByBefore.get(candidate.before);
    if (bucket) bucket.push(candidate);
    else bestByBefore.set(candidate.before, [candidate]);
  }

  const matched: IdentityMatchDetail[] = [];
  const ambiguous: IdentityMatchDetail[] = [];
  const usedBefore = new Set<NodeId>();
  const usedAfter = new Set<NodeId>();

  for (const candidate of viable) {
    if (usedBefore.has(candidate.before) || usedAfter.has(candidate.after)) {
      continue;
    }

    const rivals = (bestByBefore.get(candidate.before) ?? []).filter(
      (rival) => rival.after !== candidate.after && !usedAfter.has(rival.after),
    );
    const runnerUp = rivals[0]?.score ?? 0;

    // A near-tie is reported, not resolved. Retargeting an issue onto the
    // wrong node silences a real finding somewhere nobody is looking, which is
    // strictly worse than losing a UX- number.
    if (runnerUp > 0 && candidate.score - runnerUp < thresholds.margin) {
      ambiguous.push(candidate);
      continue;
    }

    matched.push(candidate);
    usedBefore.add(candidate.before);
    usedAfter.add(candidate.after);
  }

  return { matched, ambiguous };
}

function nodesOf(
  input: GraphDocument | GraphIdentitySnapshot,
): IdentityNode[] {
  return "nodes" in input && "schemaVersion" in input && !("edges" in input)
    ? (input as GraphIdentitySnapshot).nodes
    : identityNodes(input as GraphDocument);
}

function exactSimilarity(
  a: string | undefined,
  b: string | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined || b === undefined) return 0;
  return a === b ? 1 : 0;
}

function textSimilarity(
  a: string | undefined,
  b: string | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined || b === undefined) return 0;

  const left = slugify(a);
  const right = slugify(b);
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  // Containment catches the shortening people actually do: `approveInvoice`
  // becomes `approve`, `InvoiceTable` becomes `Table`.
  if (left.includes(right) || right.includes(left)) return 0.6;
  return 0;
}

function symbolSimilarity(
  a: readonly string[],
  b: readonly string[],
): number | undefined {
  if (a.length === 0 && b.length === 0) return undefined;
  if (a.length === 0 || b.length === 0) return 0;

  let best = 0;
  for (const left of a) {
    for (const right of b) {
      best = Math.max(best, textSimilarity(left, right) ?? 0);
      if (best === 1) return 1;
    }
  }
  return best;
}

function routeSimilarity(
  a: string | undefined,
  b: string | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined || b === undefined) return 0;
  if (a === b) return 1;

  const left = routeSegments(a);
  const right = routeSegments(b);
  if (left.length === 0 && right.length === 0) return 1;

  const shared = left.filter((segment) => right.includes(segment)).length;
  const union = new Set([...left, ...right]).size;
  const overlap = union === 0 ? 0 : shared / union;

  // Depth agreement, weighted lightly. `/invoices/[id]` turning into
  // `/bills/[id]` keeps its shape even though the leading segment changed,
  // and shape is weak evidence that survives a rename.
  const sameDepth = left.length === right.length ? 0.15 : 0;
  return Math.min(1, overlap + sameDepth);
}

function fileSimilarity(
  a: readonly string[],
  b: readonly string[],
): number | undefined {
  if (a.length === 0 && b.length === 0) return undefined;
  if (a.length === 0 || b.length === 0) return 0;

  let best = 0;
  for (const left of a) {
    for (const right of b) {
      if (left === right) return 1;
      // A shared basename is weaker here than it looks, because Next.js names
      // files by convention: every App Router screen is `page.tsx`, so two
      // completely unrelated screens agree on it. Deliberately below the 0.5
      // line that counts as supporting evidence — it can nudge a score, but it
      // cannot be the reason for a match.
      if (basename(left) === basename(right)) best = Math.max(best, 0.4);
      else if (directory(left) === directory(right)) best = Math.max(best, 0.3);
    }
  }
  return best;
}

/**
 * Jaccard over neighbours, translated through the matches so far.
 *
 * The translation is the point: comparing raw neighbour ids would fail for
 * exactly the graphs this exists to handle, where the neighbours were renamed
 * too. Neighbours with no counterpart yet count against the pair, which is
 * correct — an unmatchable neighbourhood is evidence of a different node.
 */
function neighbourhoodSimilarity(
  a: readonly NodeId[],
  b: readonly NodeId[],
  mapping: ReadonlyMap<NodeId, NodeId>,
): number | undefined {
  if (a.length === 0 && b.length === 0) return undefined;
  if (a.length === 0 || b.length === 0) return 0;

  const projected = new Set(a.map((id) => mapping.get(id) ?? `unmatched:${id}`));
  const target = new Set(b);

  let shared = 0;
  for (const id of target) if (projected.has(id)) shared += 1;

  const union = new Set([...projected, ...target]).size;
  return union === 0 ? 0 : shared / union;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function directory(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}
