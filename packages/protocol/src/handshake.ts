import { IR_SCHEMA_VERSION } from "@drumlin/model";

/**
 * The version handshake.
 *
 * A daemon outlives the client that spawned it, so the two can be different
 * builds after an upgrade. Every connection asks first, and a client that gets
 * a version it does not know asks the daemon to exit rather than guessing at
 * the shape of a reply.
 *
 * See Context/14 MCP and Local Daemon API.md
 */

/** Bumped whenever a method's params or result shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

/** Bumped when `.drumlin/` layout changes in a way an older daemon misreads. */
export const WORKSPACE_SCHEMA_VERSION = 1;

/**
 * What the daemon can do, so a client can degrade instead of erroring.
 *
 * Milestone B has no runtime verifier and no orchestrator, and saying so is
 * more useful than a method-not-found at the moment an agent asks.
 */
export const DAEMON_CAPABILITIES = [
  "graph",
  "issues",
  "check",
  "context",
  "session",
] as const;

export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

export interface HandshakeResult {
  protocolVersion: number;
  daemonVersion: string;
  workspaceSchemaVersion: number;
  irSchemaVersion: number;
  capabilities: string[];
  /** So a client can report which process it is talking to. */
  pid: number;
  startedAt: string;
}

export const HANDSHAKE_METHOD = "daemon.hello";

export function handshakeResult(
  daemonVersion: string,
  startedAt: string,
): HandshakeResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    daemonVersion,
    workspaceSchemaVersion: WORKSPACE_SCHEMA_VERSION,
    irSchemaVersion: IR_SCHEMA_VERSION,
    capabilities: [...DAEMON_CAPABILITIES],
    pid: process.pid,
    startedAt,
  };
}

export interface VersionVerdict {
  compatible: boolean;
  reason?: string;
}

/**
 * Whether a client can speak to this daemon.
 *
 * Strict equality on the protocol version, deliberately. A mismatch is always
 * recoverable by restarting the daemon, and the alternative — negotiating a
 * subset — is a lot of machinery to support two versions that only ever exist
 * seconds apart during an upgrade.
 */
export function checkVersions(result: HandshakeResult): VersionVerdict {
  if (result.protocolVersion !== PROTOCOL_VERSION) {
    return {
      compatible: false,
      reason:
        `daemon speaks protocol ${result.protocolVersion}, ` +
        `this client speaks ${PROTOCOL_VERSION}`,
    };
  }
  if (result.irSchemaVersion !== IR_SCHEMA_VERSION) {
    return {
      compatible: false,
      reason:
        `daemon builds IR schema ${result.irSchemaVersion}, ` +
        `this client reads ${IR_SCHEMA_VERSION}`,
    };
  }
  return { compatible: true };
}
