import { existsSync } from "node:fs";
import { daemonPaths, type DaemonPaths } from "@drumlin/repo";
// Types only. The implementation is imported on demand in `inProcess()`,
// because loading it drags in the parser.
import type { Engine, EngineMethod, EngineMethods } from "@drumlin/engine";
import type { DaemonEventName, HandshakeResult } from "@drumlin/protocol";
import { DaemonConnection } from "./connection.js";
import { spawnDaemon, waitForSocket } from "./spawn.js";

/**
 * The engine, over a socket.
 *
 * Identical surface to `InProcessEngine` — which is the payoff DEC-0002 was
 * betting on. Every command written at Milestone A works unchanged; only which
 * object it holds changes.
 */
export class RemoteEngine implements Engine {
  private connection: DaemonConnection | undefined;
  private handshake: HandshakeResult | undefined;

  private constructor(
    private readonly paths: DaemonPaths,
    private readonly onEvent?: (
      name: DaemonEventName,
      payload: unknown,
    ) => void,
  ) {}

  /**
   * Connect, starting a daemon if none is listening.
   *
   * Returns undefined rather than throwing when no daemon can be had, so the
   * caller can fall back in-process. A machine where spawning fails should
   * still be able to run `drumlin check`, just slower.
   */
  static async attach(
    options: AttachOptions = {},
  ): Promise<RemoteEngine | undefined> {
    const paths = options.paths ?? daemonPaths();
    const engine = new RemoteEngine(paths, options.onEvent);

    if (await engine.tryConnect()) return engine;
    if (options.spawn === false) return undefined;

    const started = await spawnDaemon({
      paths,
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    });
    if (!started) return undefined;

    return (await engine.tryConnect()) ? engine : undefined;
  }

  get daemon(): HandshakeResult | undefined {
    return this.handshake;
  }

  async request<M extends EngineMethod>(
    method: M,
    params: EngineMethods[M]["params"],
  ): Promise<EngineMethods[M]["result"]> {
    const connection = this.require();
    return (await connection.request(
      method,
      params,
    )) as EngineMethods[M]["result"];
  }

  /** Fire-and-forget notification. Nothing waits for the daemon to finish. */
  touch(root: string, files: readonly string[]): void {
    this.connection?.notify("workspace.touch", { root, files });
  }

  async subscribe(root: string, events?: DaemonEventName[]): Promise<void> {
    await this.require().subscribe(root, events);
  }

  async daemonStatus(): Promise<DaemonStatus> {
    return (await this.require().request("daemon.status")) as DaemonStatus;
  }

  async shutdown(): Promise<void> {
    await this.require().request("daemon.shutdown");
  }

  close(): void {
    this.connection?.close();
    this.connection = undefined;
  }

  private require(): DaemonConnection {
    if (!this.connection) throw new Error("Not connected to a daemon");
    return this.connection;
  }

  private async tryConnect(): Promise<boolean> {
    if (!existsSync(this.paths.socketFile)) return false;
    try {
      const connection = await DaemonConnection.connect({
        socketFile: this.paths.socketFile,
        ...(this.onEvent ? { onEvent: this.onEvent } : {}),
      });
      this.handshake = await connection.hello();
      this.connection = connection;
      return true;
    } catch {
      this.connection?.close();
      this.connection = undefined;
      return false;
    }
  }
}

export interface AttachOptions {
  paths?: DaemonPaths;
  /** Do not start a daemon; only use one already running. */
  spawn?: boolean;
  idleMs?: number;
  onEvent?: (name: DaemonEventName, payload: unknown) => void;
}

export interface DaemonStatus {
  pid: number;
  startedAt: string;
  socket: string;
  connections: number;
  workspaces: Array<{
    root: string;
    revision: number;
    pendingFiles: number;
    filesParsed: number;
    lastIndexMs: number;
    indexedAt?: string;
    branch?: string;
    lastError?: string;
  }>;
  memoryMb: number;
}

export interface ResolvedEngine {
  engine: Engine;
  /** True when the work is happening in a daemon. */
  remote: boolean;
  /** Why the daemon was not used, when it was not. */
  reason?: string;
  close(): void;
}

/**
 * Pick an engine.
 *
 * Daemon by default because that is what makes the hooks viable, in-process
 * when asked. `--no-daemon` is the escape hatch DEC-0002 insists on: warm
 * state that has gone stale is indistinguishable from a rule bug, and the only
 * way to tell them apart is to run the same check without it.
 */
export async function resolveEngine(
  options: ResolveOptions = {},
): Promise<ResolvedEngine> {
  if (options.daemon === false) {
    return {
      engine: await inProcess(),
      remote: false,
      reason: "disabled with --no-daemon",
      close: () => {},
    };
  }

  const remote = await RemoteEngine.attach({
    ...(options.paths ? { paths: options.paths } : {}),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });

  if (remote) {
    return { engine: remote, remote: true, close: () => remote.close() };
  }

  return {
    engine: await inProcess(),
    remote: false,
    reason: "no daemon available",
    close: () => {},
  };
}

/**
 * The fallback engine, loaded only when it is actually needed.
 *
 * A static import here would be simpler and would cost every client the whole
 * analysis stack — indexer, rules, ts-morph — merely to open a socket. That is
 * paid per process, and Cursor starts a fresh process for every hook: measured
 * at ~250ms of the `afterFileEdit` hook's 500ms budget, spent loading a parser
 * it never uses.
 */
async function inProcess(): Promise<Engine> {
  const { InProcessEngine } = await import("@drumlin/engine");
  return new InProcessEngine();
}

export interface ResolveOptions extends AttachOptions {
  /** False forces in-process. */
  daemon?: boolean;
}

export { waitForSocket };
