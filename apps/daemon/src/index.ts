/**
 * @drumlin/daemon — `drumlind`, the process that holds the warm graph.
 *
 * Extracted at Milestone B per DEC-0002. It exists because the Cursor hooks
 * fire on every edit and cannot afford a cold index, and because the MCP
 * server needs a long-lived graph to answer an agent mid-session.
 */
export { Daemon, DAEMON_VERSION, type DaemonOptions } from "./server.js";
export { WarmEngine } from "./engine.js";
export {
  WarmWorkspace,
  WorkspaceRegistry,
  type WorkspaceEvent,
  type WorkspaceStatusSnapshot,
} from "./workspace.js";
export { workspaceIdentity, type WorkspaceIdentity } from "./identity.js";
export {
  canConnect,
  clearStaleSocket,
  isProcessAlive,
  probeSocket,
  readPid,
  type SocketProbe,
} from "./lifecycle.js";
export { main } from "./main.js";
