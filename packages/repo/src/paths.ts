import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The `.drumlin/` repository contract.
 *
 * Two layers, deliberately: everything under here except `cache/` is meant to
 * be human-readable and reviewable, while `cache/` is derived and disposable.
 * Deleting the cache must never lose a fact.
 *
 * See vault/Architecture/Two-Layer Storage.md and Context/03 Repository Contract.md
 */
export const DRUMLIN_DIR = ".drumlin";

export interface RepoPaths {
  root: string;
  /** `.drumlin/` itself. */
  dir: string;
  /** Committed: what the product is meant to be. */
  contextDir: string;
  permissionsFile: string;
  /** Committed: durable issue records. */
  issuesDir: string;
  issuesIndexFile: string;
  /** Committed: configuration. */
  configFile: string;
  /** Derived and disposable. */
  cacheDir: string;
  cacheDbFile: string;
}

/**
 * The nearest ancestor holding a `.drumlin/`, starting from `from`.
 *
 * Some commands care where the records live and not what framework is in the
 * repository. `drumlin activate` is the clearest case: it writes one flag into
 * `config.yaml`, and routing it through app resolution meant it refused to run
 * wherever Drumlin could not find a Next.js app — which includes the repository
 * root of most monorepos, the obvious place to run it from.
 *
 * Returns nothing rather than falling back to `from`, so a caller has to say
 * what it wants to happen when there are no records at all.
 */
export function findRepoRoot(from: string): string | undefined {
  let current = resolve(from);

  for (;;) {
    if (existsSync(join(current, DRUMLIN_DIR))) return current;
    const parent = dirname(current);
    // `dirname("/") === "/"`, which is the only reliable way to know the walk
    // is finished on every platform.
    if (parent === current) return undefined;
    current = parent;
  }
}

export function repoPaths(root: string): RepoPaths {
  const dir = join(root, DRUMLIN_DIR);
  const contextDir = join(dir, "context");
  const issuesDir = join(dir, "issues");
  const cacheDir = join(dir, "cache");

  return {
    root,
    dir,
    contextDir,
    permissionsFile: join(contextDir, "permissions.yaml"),
    issuesDir,
    issuesIndexFile: join(issuesDir, "index.json"),
    configFile: join(dir, "config.yaml"),
    cacheDir,
    cacheDbFile: join(cacheDir, "index.db"),
  };
}

export interface DaemonPaths {
  /** Per-user state directory holding the socket, PID file, and log. */
  dir: string;
  socketFile: string;
  pidFile: string;
  logFile: string;
}

/**
 * Where the daemon lives.
 *
 * Per user rather than per workspace, because one process serving every open
 * repository is the whole reason the daemon exists — see Process Ownership in
 * Context/02. The path is kept deliberately short: a Unix domain socket
 * address is capped at 104 bytes on macOS, and a long home directory plus
 * `Library/Application Support/Drumlin/daemon.sock` gets close enough to that
 * to fail on someone's machine rather than mine.
 */
export function daemonPaths(): DaemonPaths {
  const dir = daemonStateDir();
  return {
    dir,
    socketFile: join(dir, "d.sock"),
    pidFile: join(dir, "d.pid"),
    logFile: join(dir, "daemon.log"),
  };
}

function daemonStateDir(): string {
  const override = process.env["DRUMLIN_STATE_DIR"];
  if (override) return override;

  // XDG is respected where it is set, including on macOS, because a developer
  // who sets it has already decided where machine-local state belongs.
  const xdg = process.env["XDG_RUNTIME_DIR"] ?? process.env["XDG_STATE_HOME"];
  if (xdg) return join(xdg, "drumlin");

  const home = homedir();
  if (!home) return join(tmpdir(), "drumlin");

  return platform() === "darwin"
    ? join(home, "Library", "Caches", "drumlin")
    : join(home, ".local", "state", "drumlin");
}
