/**
 * @drumlin/client — talking to `drumlind`.
 *
 * Holds the socket, the JSON-RPC correlation, auto-spawn, and the decision
 * between a daemon and an in-process engine. Every first-party client goes
 * through here: the CLI, the hooks, and the MCP server.
 */
export { DaemonConnection, type ConnectionOptions } from "./connection.js";
export { daemonCommand, spawnDaemon, waitForSocket, type SpawnOptions } from "./spawn.js";
export {
  RemoteEngine,
  resolveEngine,
  type AttachOptions,
  type DaemonStatus,
  type ResolvedEngine,
  type ResolveOptions,
} from "./remote.js";
