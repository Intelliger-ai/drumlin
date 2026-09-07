/**
 * The daemon event vocabulary.
 *
 * Events are notifications: the daemon pushes them, nobody replies. Milestone B
 * emits only the ones it can honestly claim — there is no verifier and no
 * orchestrator yet, so `verification.*` and `agent.*` from Context/14 are
 * absent rather than stubbed. A capability a client can subscribe to but never
 * receive is worse than one that is missing.
 */

export const DAEMON_EVENTS = [
  "workspace.changed",
  "graph.updated",
  "index.failed",
] as const;

export type DaemonEventName = (typeof DAEMON_EVENTS)[number];

/** A file in an open workspace changed on disk. */
export interface WorkspaceChangedEvent {
  workspace: string;
  files: string[];
}

/** The warm graph finished rebuilding. `revision` advances on every rebuild. */
export interface GraphUpdatedEvent {
  workspace: string;
  revision: number;
  durationMs: number;
  screens: number;
  edges: number;
}

/** A background re-index threw. The previous graph is still being served. */
export interface IndexFailedEvent {
  workspace: string;
  message: string;
}

export interface DaemonEvents {
  "workspace.changed": WorkspaceChangedEvent;
  "graph.updated": GraphUpdatedEvent;
  "index.failed": IndexFailedEvent;
}

export const SUBSCRIBE_METHOD = "workspace.subscribe";

export interface SubscribeParams {
  root: string;
  events?: DaemonEventName[];
}
