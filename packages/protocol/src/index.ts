/**
 * @drumlin/protocol — the daemon wire protocol.
 *
 * Pure: envelopes, framing, version handshake, and event names. Nothing here
 * opens a socket or reads a file, so the same types describe both ends and the
 * transport can be tested without a process.
 *
 * See Context/14 MCP and Local Daemon API.md and vault/Decisions/DEC-0002.
 */
export * from "./jsonrpc.js";
export * from "./ndjson.js";
export * from "./handshake.js";
export * from "./events.js";
