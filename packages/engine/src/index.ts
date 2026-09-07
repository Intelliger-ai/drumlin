/**
 * @drumlin/engine — every capability, behind one request surface.
 *
 * The interface lives apart from the CLI because it now has three callers: the
 * CLI in-process, the daemon serving a socket, and the MCP server serving an
 * agent. DEC-0002 turns on this being the only way in — if a command reaches
 * around it, extracting the daemon stops being a transport change.
 */
export * from "./types.js";
export * from "./in-process.js";
export { flowFor, findScreen } from "./flow.js";
export { buildPacket, type PacketInput } from "./packet.js";
