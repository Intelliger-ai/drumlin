import {
  InProcessEngine,
  resolveAppFor,
  type GraphGetParams,
  type GraphGetResult,
  type WorkspaceStatusParams,
  type WorkspaceStatusResult,
} from "@drumlin/engine";
import { existsSync } from "node:fs";
import { repoPaths } from "@drumlin/repo";
import { WorkspaceRegistry } from "./workspace.js";

/**
 * The engine, backed by warm state.
 *
 * Only graph acquisition and status change: everything downstream — rules,
 * reconciliation, issue persistence — is the same code the CLI runs, because
 * two implementations of "what counts as a finding" would diverge and the
 * divergence would surface as the daemon and the CLI disagreeing about the
 * same repository.
 */
export class WarmEngine extends InProcessEngine {
  readonly registry = new WorkspaceRegistry();

  protected override async graphGet(
    params: GraphGetParams,
  ): Promise<GraphGetResult> {
    const app = resolveAppFor(params);
    const workspace = this.registry.acquire(app);

    const result =
      params.cache === false ? workspace.reindex() : workspace.graph();

    return {
      graph: result.graph,
      stats: result.stats,
      brokenLinks: result.brokenLinks,
      // Warm is not cached. The derived cache is an on-disk artifact for cold
      // processes; reporting a warm read as `cached` would tell a developer
      // debugging a stale finding to go and delete the wrong thing.
      cached: false,
    };
  }

  protected override workspaceStatus(
    params: WorkspaceStatusParams,
  ): WorkspaceStatusResult {
    const app = resolveAppFor(params);
    const existing = this.registry.find(app.root);
    const snapshot = existing?.status();

    const result: WorkspaceStatusResult = {
      root: app.root,
      app,
      warm: snapshot?.warm ?? false,
      revision: snapshot?.revision ?? 0,
      pendingFiles: snapshot?.pendingFiles ?? 0,
      persisted: existsSync(repoPaths(app.root).dir),
      daemonPid: process.pid,
    };
    if (snapshot?.indexedAt) result.indexedAt = snapshot.indexedAt;
    return result;
  }

  /** Fold reported edits into whichever workspace owns them. */
  touch(root: string, files: readonly string[]): number {
    return this.registry.find(root)?.notifyChanged(files) ?? 0;
  }

  close(): void {
    this.registry.closeAll();
  }
}
