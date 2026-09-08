/**
 * Whether this Node can run Drumlin, decided before anything needs it to.
 *
 * `packages/repo/src/cache.ts` uses `node:sqlite`, which arrived in Node 22.
 * On Node 20 the failure is `Cannot find module 'node:sqlite'`, thrown from a
 * cache layer several imports deep, at a moment that has nothing to do with
 * the cause. A first-time reader has no way to get from that to "upgrade
 * Node", and the version they are running is not in the message.
 *
 * Pure, and takes the version as an argument, for the same reason
 * `classifyCaller` takes `env`: the interesting cases are versions this
 * machine is not running, and a function that reads `process` cannot be asked
 * about them.
 *
 * Reachable as `@drumlin/model/runtime` rather than through the package index,
 * because the CLI has to run this before anything else and the index pulls in
 * every schema and zod with them. That is startup cost on the hook path, which
 * is measured against a 500ms budget it already spends 380ms of.
 */

/** The floor, and the reason for it, kept together so they cannot drift. */
export const MINIMUM_NODE = 22;

export const MINIMUM_NODE_REASON = "node:sqlite, which Drumlin uses to cache";

/**
 * A message if this version cannot run Drumlin, `undefined` if it can.
 *
 * Unparseable versions pass. Somebody running an unreleased build or an
 * alternative runtime is better served by the real failure than by a guess
 * from a version string this function did not understand.
 */
export function unsupportedNode(version: string): string | undefined {
  const major = majorOf(version);
  if (major === undefined || major >= MINIMUM_NODE) return undefined;

  return (
    `Drumlin needs Node ${MINIMUM_NODE} or newer; this is Node ${version}.\n` +
    `  It requires ${MINIMUM_NODE_REASON}, added in Node ${MINIMUM_NODE}.\n` +
    `  Upgrade, or run through a version manager: \`nvm use ${MINIMUM_NODE}\`.`
  );
}

function majorOf(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version.trim());
  if (!match?.[1]) return undefined;

  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : undefined;
}
