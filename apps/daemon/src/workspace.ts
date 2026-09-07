import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  IndexSession,
  isAnalyzableSource,
  type IndexResult,
  type NextApp,
} from "@drumlin/indexer";
import { workspaceIdentity, type WorkspaceIdentity } from "./identity.js";

/**
 * One app, parsed and kept.
 *
 * The contract with callers is that `graph()` never returns something stale.
 * That sounds obvious and is the entire reason this class is careful: a warm
 * graph that silently lags the filesystem produces findings that look exactly
 * like rule bugs, which DEC-0002 already identified as the expensive failure
 * mode of caching. So changes are folded in before a read is answered, and
 * separately in the background so the common case has nothing to fold.
 */

/**
 * How long to wait for edits to stop before rebuilding.
 *
 * An agent writing a file produces several change events, and a developer
 * saving repeatedly produces more. Rebuilding per event would spend the warm
 * graph's whole advantage on work that is immediately invalidated.
 */
const REBUILD_DEBOUNCE_MS = 250;

export interface WorkspaceStatusSnapshot {
  root: string;
  warm: boolean;
  revision: number;
  indexedAt?: string;
  pendingFiles: number;
  branch?: string;
  filesParsed: number;
  lastIndexMs: number;
  lastError?: string;
}

export type WorkspaceListener = (event: WorkspaceEvent) => void;

export type WorkspaceEvent =
  | { type: "changed"; root: string; files: string[] }
  | {
      type: "indexed";
      root: string;
      revision: number;
      durationMs: number;
      screens: number;
      edges: number;
    }
  | { type: "failed"; root: string; message: string };

export class WarmWorkspace {
  readonly identity: WorkspaceIdentity;
  private readonly session: IndexSession;
  private result: IndexResult;
  private revision = 1;
  private indexedAt: string;
  private lastIndexMs: number;
  private lastError: string | undefined;

  private readonly pending = new Set<string>();
  private rebuildTimer: NodeJS.Timeout | undefined;
  private watcher: FSWatcher | undefined;
  private readonly listeners = new Set<WorkspaceListener>();

  private constructor(app: NextApp, identity: WorkspaceIdentity) {
    this.identity = identity;
    const started = Date.now();
    this.session = new IndexSession(app);
    this.result = this.session.index();
    this.lastIndexMs = Date.now() - started;
    this.indexedAt = new Date().toISOString();
  }

  static open(app: NextApp): WarmWorkspace {
    const workspace = new WarmWorkspace(app, workspaceIdentity(app.root));
    workspace.startWatching();
    return workspace;
  }

  get app(): NextApp {
    return this.session.app;
  }

  on(listener: WorkspaceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The current graph, with any outstanding changes folded in first.
   *
   * Synchronous folding on the read path is what makes freshness a guarantee
   * rather than a hope. The debounced background rebuild usually gets there
   * first, in which case this costs a set lookup.
   */
  graph(): IndexResult {
    if (this.pending.size > 0) this.rebuild();
    return this.result;
  }

  /** Discard everything and parse from scratch. Backs `--no-cache`. */
  reindex(): IndexResult {
    this.session.refresh([...this.session.files]);
    this.pending.clear();
    this.rebuild(true);
    return this.result;
  }

  /**
   * Note that files changed.
   *
   * Called from both the watcher and the editor hooks. The two overlap and that
   * is deliberate: the watcher is the only thing that sees a hand-typed edit,
   * and the hook is the only thing that sees a write the instant it lands
   * rather than whenever the platform gets around to reporting it.
   */
  notifyChanged(files: readonly string[]): number {
    const accepted: string[] = [];
    for (const file of files) {
      if (!isAnalyzableSource(file)) continue;
      this.pending.add(file);
      accepted.push(file);
    }

    if (accepted.length === 0) return 0;

    this.emit({ type: "changed", root: this.identity.root, files: accepted });
    this.scheduleRebuild();
    return accepted.length;
  }

  status(): WorkspaceStatusSnapshot {
    const snapshot: WorkspaceStatusSnapshot = {
      root: this.identity.root,
      warm: true,
      revision: this.revision,
      indexedAt: this.indexedAt,
      pendingFiles: this.pending.size,
      filesParsed: this.session.files.length,
      lastIndexMs: this.lastIndexMs,
    };
    if (this.identity.branch) snapshot.branch = this.identity.branch;
    if (this.lastError) snapshot.lastError = this.lastError;
    return snapshot;
  }

  close(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.listeners.clear();
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      if (this.pending.size === 0) return;
      this.rebuild();
    }, REBUILD_DEBOUNCE_MS);
    this.rebuildTimer.unref?.();
  }

  private rebuild(force = false): void {
    const changed = [...this.pending];
    this.pending.clear();

    const started = Date.now();
    try {
      if (changed.length > 0) this.session.refresh(changed);
      else if (!force) return;

      this.result = this.session.index();
      this.revision += 1;
      this.lastIndexMs = Date.now() - started;
      this.indexedAt = new Date().toISOString();
      this.lastError = undefined;

      this.emit({
        type: "indexed",
        root: this.identity.root,
        revision: this.revision,
        durationMs: this.lastIndexMs,
        screens: this.result.stats.screens,
        edges: this.result.stats.edges,
      });
    } catch (error) {
      // A rebuild that throws leaves the previous graph in place. Mid-edit code
      // does not parse, and answering with the last good graph is far better
      // than turning every keystroke into an error the developer has to read.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "failed",
        root: this.identity.root,
        message: this.lastError,
      });
    }
  }

  /**
   * Watch the app for changes nobody told us about.
   *
   * Cursor has no file-save hook — every documented trigger is agent-driven or
   * Tab-driven — so without this, code the developer types by hand is invisible
   * until the next cold run. Recursive watching is used where the platform
   * supports it, and its absence is not fatal: the hooks still report edits.
   */
  private startWatching(): void {
    const target = this.app.appDir ?? this.app.pagesDir ?? this.app.root;
    const base = watchBase(target, this.app.root);

    try {
      this.watcher = watch(
        base,
        { recursive: true, persistent: false },
        (_event, filename) => {
          if (!filename) return;
          this.notifyChanged([join(base, filename.toString())]);
        },
      );
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.watcher = undefined;
    }
  }

  private emit(event: WorkspaceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A subscriber that throws must not take down the indexer.
      }
    }
  }
}

/**
 * Where to point the watcher.
 *
 * The app root would cover everything, including `node_modules` and `.next`,
 * whose churn during a dev server is relentless. Watching `src/` when it
 * exists is both narrower and enough, since that is where the router and every
 * component live.
 */
function watchBase(routerDir: string, root: string): string {
  const src = join(root, "src");
  return routerDir.startsWith(src) ? src : routerDir;
}

/**
 * Every open workspace in this process.
 *
 * Keyed by identity rather than by the path the caller happened to type, so
 * `/tmp/app`, `/tmp/app/`, and a symlink to it all find the same warm graph.
 */
export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, WarmWorkspace>();
  private readonly listeners = new Set<WorkspaceListener>();

  acquire(app: NextApp): WarmWorkspace {
    const identity = workspaceIdentity(app.root);
    const existing = this.workspaces.get(identity.key);
    if (existing) return existing;

    const workspace = WarmWorkspace.open(app);
    workspace.on((event) => this.fanOut(event));
    this.workspaces.set(identity.key, workspace);
    return workspace;
  }

  /** The warm workspace for a root, without opening one. */
  find(root: string): WarmWorkspace | undefined {
    return this.workspaces.get(workspaceIdentity(root).key);
  }

  on(listener: WorkspaceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): WorkspaceStatusSnapshot[] {
    return [...this.workspaces.values()].map((workspace) => workspace.status());
  }

  get size(): number {
    return this.workspaces.size;
  }

  closeAll(): void {
    for (const workspace of this.workspaces.values()) workspace.close();
    this.workspaces.clear();
    this.listeners.clear();
  }

  private fanOut(event: WorkspaceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Isolated per subscriber.
      }
    }
  }
}
