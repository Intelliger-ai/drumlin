import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { daemonPaths, type DaemonPaths } from "@drumlin/repo";
import type { EngineMethod, EngineMethods } from "@drumlin/engine";
import {
  encodeMessage,
  handshakeResult,
  isNotification,
  isRequest,
  MessageDecoder,
  rpcFailure,
  rpcNotification,
  rpcSuccess,
  toRpcError,
  HANDSHAKE_METHOD,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  SUBSCRIBE_METHOD,
  type DaemonEventName,
  type RpcMessage,
  type RpcRequest,
} from "@drumlin/protocol";
import { WarmEngine } from "./engine.js";
import {
  clearPid,
  clearStaleSocket,
  IdleTimer,
  probeSocket,
  writePid,
} from "./lifecycle.js";
import type { WorkspaceEvent } from "./workspace.js";

export const DAEMON_VERSION = "0.1.0";

/** Exit after half an hour of nobody asking anything. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/** Methods the daemon serves itself rather than forwarding to the engine. */
const DAEMON_METHODS = new Set<string>([
  HANDSHAKE_METHOD,
  SUBSCRIBE_METHOD,
  "daemon.status",
  "daemon.shutdown",
  "workspace.touch",
]);

/**
 * Methods that must not travel over the socket at all.
 *
 * Keeping `issue.accept` out of the MCP tool list stopped an agent asking
 * politely; it did nothing about an agent opening this socket, which is mode
 * 0600 and therefore wide open to every process running as the same user —
 * including the agent's shell. Any check for "is a person doing this" has to
 * happen in the process that owns the terminal, so accepting is a local CLI
 * operation and there is deliberately no remote path to it.
 */
const HUMAN_ONLY_METHODS = new Set<string>(["issue.accept"]);

export interface DaemonOptions {
  paths?: DaemonPaths;
  idleMs?: number;
  /** Called instead of `process.exit` when the daemon decides to stop. */
  onStop?: () => void;
}

interface Connection {
  socket: Socket;
  decoder: MessageDecoder;
  subscriptions: Map<string, Set<DaemonEventName> | "all">;
}

export class Daemon {
  private readonly engine = new WarmEngine();
  private readonly paths: DaemonPaths;
  private readonly connections = new Set<Connection>();
  private readonly idle: IdleTimer;
  private readonly startedAt = new Date().toISOString();
  private server: Server | undefined;
  private stopping = false;

  constructor(private readonly options: DaemonOptions = {}) {
    this.paths = options.paths ?? daemonPaths();
    this.idle = new IdleTimer(options.idleMs ?? DEFAULT_IDLE_MS, () =>
      this.stop("idle"),
    );
  }

  get socketFile(): string {
    return this.paths.socketFile;
  }

  /**
   * Take the socket, or refuse.
   *
   * Refusing when another daemon is already listening is the correct outcome,
   * not a failure: a second process would hold a second copy of every parsed
   * app and the two would disagree about freshness.
   */
  async listen(): Promise<void> {
    const probe = await probeSocket(this.paths);
    if (probe.state === "listening") {
      throw new Error(
        `A daemon is already listening on ${this.paths.socketFile}` +
          (probe.pid ? ` (pid ${probe.pid})` : ""),
      );
    }
    if (probe.state === "stale") clearStaleSocket(this.paths);

    mkdirSync(this.paths.dir, { recursive: true });

    const server = createServer((socket) => this.accept(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.paths.socketFile, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    // The socket is the only access control there is: anything that can connect
    // can read the developer's source tree through `graph.get`. Owner-only
    // permissions keep that to the user who started it, which is the trust
    // boundary Context/20 assumes for a local workspace.
    chmodSync(this.paths.socketFile, 0o600);
    writePid(this.paths);

    this.engine.registry.on((event) => this.publish(event));
    this.idle.start();
  }

  stop(reason: string): void {
    if (this.stopping) return;
    this.stopping = true;

    this.idle.stop();
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    this.engine.close();
    this.server?.close();
    clearPid(this.paths);
    clearStaleSocket(this.paths);

    if (this.options.onStop) this.options.onStop();
    else process.exitCode = reason === "idle" ? 0 : process.exitCode ?? 0;
  }

  private accept(socket: Socket): void {
    const connection: Connection = {
      socket,
      decoder: new MessageDecoder(),
      subscriptions: new Map(),
    };
    this.connections.add(connection);

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      const { messages, errors } = connection.decoder.push(chunk);
      for (const error of errors) {
        this.send(
          connection,
          rpcFailure(null, RPC_PARSE_ERROR, `Malformed message: ${error.message}`),
        );
      }
      for (const message of messages) {
        void this.handle(connection, message);
      }
    });

    const drop = (): void => {
      this.connections.delete(connection);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private async handle(
    connection: Connection,
    message: RpcMessage,
  ): Promise<void> {
    this.idle.reset();

    if (isNotification(message)) {
      // Fire-and-forget, which is what the `afterFileEdit` hook uses: it must
      // return before the next keystroke, so it cannot wait for a reply.
      switch (message.method) {
        case "workspace.touch":
          this.touch(message.params);
          return;
        case "workspace.warm":
          // The `workspaceOpen` hook fires this and exits. Parsing a large app
          // takes seconds, and holding a window open for them would be worse
          // than the cold index it is trying to avoid.
          void this.warm(message.params);
          return;
        default:
          return;
      }
    }

    if (!isRequest(message)) {
      this.send(
        connection,
        rpcFailure(null, RPC_INVALID_REQUEST, "Expected a request or notification"),
      );
      return;
    }

    try {
      const result = await this.dispatch(connection, message);
      this.send(connection, rpcSuccess(message.id, result));
    } catch (error) {
      const code =
        error instanceof MethodNotFound
          ? RPC_METHOD_NOT_FOUND
          : error instanceof InvalidParams
            ? RPC_INVALID_PARAMS
            : undefined;
      this.send(
        connection,
        rpcFailure(
          message.id,
          code ?? toRpcError(error).code,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async dispatch(
    connection: Connection,
    request: RpcRequest,
  ): Promise<unknown> {
    switch (request.method) {
      case HANDSHAKE_METHOD:
        return handshakeResult(DAEMON_VERSION, this.startedAt);

      case "daemon.status":
        return {
          pid: process.pid,
          startedAt: this.startedAt,
          socket: this.paths.socketFile,
          connections: this.connections.size,
          workspaces: this.engine.registry.list(),
          memoryMb: Math.round(process.memoryUsage().heapUsed / 1_048_576),
        };

      case "daemon.shutdown":
        // Answered before stopping, so the caller learns it worked.
        setTimeout(() => this.stop("requested"), 10).unref?.();
        return { stopping: true };

      case SUBSCRIBE_METHOD: {
        const params = request.params as
          | { root?: string; events?: DaemonEventName[] }
          | undefined;
        if (!params?.root) throw new InvalidParams("subscribe needs a root");
        connection.subscriptions.set(
          params.root,
          params.events ? new Set(params.events) : "all",
        );
        return { subscribed: true };
      }

      case "workspace.touch":
        return { recorded: this.touch(request.params) };

      default: {
        if (DAEMON_METHODS.has(request.method)) {
          throw new MethodNotFound(request.method);
        }
        if (HUMAN_ONLY_METHODS.has(request.method)) {
          throw new InvalidParams(
            `${request.method} is not served over the socket. It needs a ` +
              `terminal a person is sitting at, so it runs in the CLI process ` +
              `instead. Use \`drumlin accept\` directly, or \`drumlin propose\` ` +
              `if you are an agent.`,
          );
        }
        return this.engine.request(
          request.method as EngineMethod,
          request.params as EngineMethods[EngineMethod]["params"],
        );
      }
    }
  }

  /**
   * Record changed files, and credit them to a session if one is named.
   *
   * Both jobs in one message on purpose. The `afterFileEdit` hook used to send
   * this notification and then wait on a separate `session.touch` request,
   * which put a full round trip — and, when the debounced re-index had already
   * started, the re-index itself — on the hot path. Measured at 737ms against
   * a 500ms budget, on a hook that fires on every write an agent makes.
   */
  private touch(params: unknown): number {
    const typed = params as
      | { root?: string; files?: string[]; sessionId?: string }
      | undefined;
    if (!typed?.root || !Array.isArray(typed.files)) return 0;

    const recorded = this.engine.touch(typed.root, typed.files);

    if (typed.sessionId) {
      // Failure here must not affect the caller: a missing session means the
      // diff falls back to fingerprints, which is a worse answer, not a
      // broken one.
      void this.engine
        .request("session.touch", {
          sessionId: typed.sessionId,
          files: typed.files,
        })
        .catch(() => undefined);
    }

    return recorded;
  }

  /** Parse an app into the registry so the next request is warm. */
  private async warm(params: unknown): Promise<void> {
    const typed = params as { root?: string; app?: string } | undefined;
    if (!typed?.root) return;
    try {
      await this.engine.request("graph.get", {
        root: typed.root,
        ...(typed.app ? { app: typed.app } : {}),
      });
    } catch {
      // A directory that is not a Next.js app is the ordinary case for a hook
      // firing in every workspace the developer opens.
    }
  }

  private publish(event: WorkspaceEvent): void {
    const name: DaemonEventName =
      event.type === "changed"
        ? "workspace.changed"
        : event.type === "indexed"
          ? "graph.updated"
          : "index.failed";

    const payload =
      event.type === "changed"
        ? { workspace: event.root, files: event.files }
        : event.type === "indexed"
          ? {
              workspace: event.root,
              revision: event.revision,
              durationMs: event.durationMs,
              screens: event.screens,
              edges: event.edges,
            }
          : { workspace: event.root, message: event.message };

    const notification = rpcNotification(name, payload);

    for (const connection of this.connections) {
      const wanted = connection.subscriptions.get(event.root);
      if (!wanted) continue;
      if (wanted !== "all" && !wanted.has(name)) continue;
      this.send(connection, notification);
    }
  }

  private send(connection: Connection, message: RpcMessage): void {
    if (connection.socket.destroyed) return;
    try {
      connection.socket.write(encodeMessage(message));
    } catch {
      // A client that hung up mid-write is not an error worth reporting.
    }
  }
}

class MethodNotFound extends Error {
  constructor(method: string) {
    super(`Unknown method: ${method}`);
  }
}

class InvalidParams extends Error {}
