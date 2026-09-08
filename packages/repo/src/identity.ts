import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoPaths } from "./paths.js";

/**
 * The graph identity baseline.
 *
 * Committed, not cached, and the reasoning is the same one that puts
 * `issues/index.json` under version control: this file is derived, but what it
 * carries is *identity*, and identity may not be regenerated differently on a
 * different machine. Delete it and the next run cannot tell a renamed route
 * from a deleted one, so every `UX-` number attached to a renamed node is
 * retired and every acceptance decision on it is lost. That is not a cache
 * miss, it is data loss, so it does not live in `cache/` — which
 * [[Two-Layer Storage]] declares disposable and `.drumlin/.gitignore` excludes.
 *
 * Kept deliberately small: node ids, types, routes, symbols, files, and
 * adjacency. Not the whole graph. It is read on every check run and reviewed in
 * diffs, and a full IR dump would be neither cheap nor readable.
 */

/** Structurally `GraphIdentitySnapshot` from @drumlin/core, which repo cannot import. */
interface Snapshot {
  schemaVersion: number;
  generatedAt?: string;
  commit?: string;
  nodes: unknown[];
}

function fileFor(root: string): string {
  return join(repoPaths(root).dir, "graph", "identity.json");
}

export function readIdentityBaseline<T extends Snapshot>(
  root: string,
): T | undefined {
  const file = fileFor(root);
  if (!existsSync(file)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as T;
    // A baseline from a future schema is not merely unreadable, it is
    // dangerous: matching against nodes whose shape we have guessed could
    // retarget an issue onto the wrong thing. Treated as absent, which loses
    // ids on one run and is the recoverable failure.
    if (!Array.isArray(parsed.nodes)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeIdentityBaseline(
  root: string,
  snapshot: Snapshot,
): string {
  const file = fileFor(root);
  mkdirSync(join(repoPaths(root).dir, "graph"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return file;
}
