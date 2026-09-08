import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { daemonPaths, type DaemonPaths } from "@drumlin/repo";

/**
 * Starting the daemon on demand.
 *
 * A developer should never have to know the daemon exists. The first command
 * that wants a warm graph starts one, detaches from it, and waits for the
 * socket to appear.
 *
 * This is the one place the client knows where the daemon lives. It depends on
 * the package so that a source checkout can resolve it by name, but the
 * dependency is not what makes this work — see `resolveDaemonEntry`, which has
 * to search, because the built CLI resolves specifiers from somewhere the
 * dependency was never installed.
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

/**
 * The daemon executable, in whichever layout this install has.
 *
 * This used to be one `import.meta.resolve("@drumlin/daemon/bin")`, which was
 * true while the CLI ran as TypeScript out of the workspace: this module lives
 * in `packages/client`, and `packages/client/node_modules/@drumlin/daemon`
 * exists. Bundling the CLI moved the code without moving that fact. From
 * `apps/cli/dist/drumlin.mjs` the specifier resolves against
 * `apps/cli/node_modules`, which never had `@drumlin/daemon` — the CLI does not
 * depend on it, the client does.
 *
 * The consequence was worse than a crash. Resolution returned nothing, the
 * caller fell back to `drumlind` on PATH, nothing is on PATH, and
 * `RemoteEngine` treats a failed spawn as "run in-process instead". So the
 * daemon quietly stopped existing and every command paid for a cold index,
 * which is the entire thing the daemon was built to avoid.
 *
 * Hence candidates, tried nearest-first, and `argv[1]` rather than
 * `import.meta.url`: the entry point is a real location in every layout, where
 * a bundled module is not.
 */
function resolveDaemonEntry(): string | undefined {
  for (const candidate of daemonCandidates()) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function daemonCandidates(): Array<string | undefined> {
  const entry = process.argv[1];
  const near: string[] = [];

  if (entry) {
    const dir = dirname(realpathOf(entry));
    near.push(
      // Built or installed. One package carries all three executables, so
      // `drumlind` sits beside whatever is running — which is the reason the
      // build assembles them into one directory rather than three.
      join(dir, "drumlind.mjs"),
      // From source via tsx: apps/cli/bin -> apps/daemon/bin.
      join(dir, "..", "..", "daemon", "bin", "drumlind.mjs"),
    );
  }

  return [...near, resolveQuietly("@drumlin/daemon/bin")];
}

function resolveQuietly(specifier: string): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return undefined;
  }
}

function realpathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
