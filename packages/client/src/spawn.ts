import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { daemonPaths, type DaemonPaths } from "@drumlin/repo";

/**
 * Starting the daemon on demand.
 *
 * A developer should never have to know the daemon exists. The first command
 * that wants a warm graph starts one, detaches from it, and waits for the
 * socket to appear.
 *
 * This is the one place the client knows where the daemon lives, which is why
 * it depends on the package: something has to hold that path, and burying it in
 * an environment variable would mean auto-spawn silently not working on a
 * machine nobody configured.
 */

export interface SpawnOptions {
  paths?: DaemonPaths;
  /** Override the command, mainly for tests. */
  command?: string[];
  idleMs?: number;
  /** How long to wait for the socket to accept connections. */
  timeoutMs?: number;
}

const DEFAULT_SPAWN_TIMEOUT_MS = 20_000;

export function daemonCommand(): string[] {
  const override = process.env["DRUMLIN_DAEMON_COMMAND"];
  if (override) return override.split(" ").filter((part) => part.length > 0);

  const entry = resolveDaemonEntry();
  return entry ? [process.execPath, entry] : ["drumlind"];
}

function resolveDaemonEntry(): string | undefined {
  try {
    const resolved = import.meta.resolve("@drumlin/daemon/bin");
    const path = fileURLToPath(resolved);
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Start a daemon and wait until it answers.
 *
 * Detached with stdio discarded, because the daemon has to outlive the command
 * that started it; a CLI invocation that exits must not take the warm graph
 * with it. Diagnostics go to the daemon's own log instead.
 */
export async function spawnDaemon(options: SpawnOptions = {}): Promise<boolean> {
  const paths = options.paths ?? daemonPaths();
  const command = options.command ?? daemonCommand();
  const [executable, ...args] = command;
  if (!executable) return false;

  if (options.idleMs !== undefined) {
    args.push("--idle-ms", String(options.idleMs));
  }

  const child = spawn(executable, args, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  return waitForSocket(
    paths.socketFile,
    options.timeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS,
  );
}

/** Poll until something accepts a connection on the socket. */
export async function waitForSocket(
  socketFile: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 25;

  while (Date.now() < deadline) {
    if (await accepts(socketFile)) return true;
    await sleep(delay);
    // Back off gently: a cold daemon on a large app takes a moment, and
    // hammering the socket does not make it arrive sooner.
    delay = Math.min(delay * 2, 250);
  }
  return false;
}

function accepts(socketFile: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!existsSync(socketFile)) {
      resolve(false);
      return;
    }
    const socket = createConnection(socketFile);
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/**
 * Deliberately keeps the event loop alive.
 *
 * An unref'd timer here means the process exits mid-wait and `spawnDaemon`
 * never settles, which shows up as a command that prints nothing at all.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
