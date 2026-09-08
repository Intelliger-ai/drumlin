import { createConnection } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { daemonPaths, type DaemonPaths } from "@drumlin/repo";

/**
 * Owning the socket.
 *
 * There is exactly one daemon per user, so starting has to answer a question
 * with three possible answers: another daemon is listening, a dead one left
 * its socket behind, or nothing is there. Getting this wrong is expensive in
 * both directions — refusing to start when the socket is stale makes the tool
 * permanently broken until someone deletes a file they have never heard of,
 * while unlinking a live socket silently steals every other client's daemon.
 *
 * The only reliable test is to connect. A PID file is a hint, not proof: PIDs
 * are reused, and a daemon may be running under a different build.
 */

export interface SocketProbe {
  state: "listening" | "stale" | "absent";
  pid?: number;
}

export async function probeSocket(paths = daemonPaths()): Promise<SocketProbe> {
  if (!existsSync(paths.socketFile)) return { state: "absent" };

  const reachable = await canConnect(paths.socketFile);
  if (reachable) {
    const pid = readPid(paths);
    return pid === undefined
      ? { state: "listening" }
      : { state: "listening", pid };
  }
  return { state: "stale" };
}

/** Connect and hang up, purely to learn whether anything is on the far end. */
export function canConnect(
  socketFile: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketFile);
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function readPid(paths = daemonPaths()): number | undefined {
  try {
    const value = Number.parseInt(
      readFileSync(paths.pidFile, "utf8").trim(),
      10,
    );
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writePid(paths: DaemonPaths): void {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.pidFile, `${process.pid}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function clearPid(paths: DaemonPaths): void {
  try {
    // Only if it is still ours: a daemon that took over after we died owns it.
    if (readPid(paths) === process.pid) rmSync(paths.pidFile, { force: true });
  } catch {
    // Nothing to clean up.
  }
}

/** Remove a socket file nothing is listening on. */
export function clearStaleSocket(paths: DaemonPaths): void {
  rmSync(paths.socketFile, { force: true });
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 checks existence and permission without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Exit after a stretch of doing nothing.
 *
 * A warm ts-morph project for a large app holds a lot of memory, and the
 * developer who ran one command last Tuesday should not still be paying for
 * it. Any request resets the clock.
 */
export class IdleTimer {
  private handle: NodeJS.Timeout | undefined;

  constructor(
    private readonly idleMs: number,
    private readonly onIdle: () => void,
  ) {}

  start(): void {
    this.reset();
  }

  reset(): void {
    if (this.idleMs <= 0) return;
    if (this.handle) clearTimeout(this.handle);
    this.handle = setTimeout(this.onIdle, this.idleMs);
    // Do not hold the event loop open on our own account.
    this.handle.unref?.();
  }

  stop(): void {
    if (this.handle) clearTimeout(this.handle);
    this.handle = undefined;
  }
}
