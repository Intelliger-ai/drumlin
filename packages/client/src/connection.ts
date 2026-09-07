import { createConnection, type Socket } from "node:net";
import {
  checkVersions,
  encodeMessage,
  HANDSHAKE_METHOD,
  isFailure,
  isNotification,
  isResponse,
  MessageDecoder,
  rpcNotification,
  rpcRequest,
  RpcClientError,
  RPC_INTERNAL_ERROR,
  RPC_VERSION_MISMATCH,
  SUBSCRIBE_METHOD,
  type DaemonEventName,
  type HandshakeResult,
  type RequestId,
  type RpcMessage,
} from "@drumlin/protocol";

/**
 * A connection to the daemon.
 *
 * One socket, many in-flight requests, correlated by id — which is why the
 * protocol is JSON-RPC rather than a request/response pipe. The MCP server in
 * particular has an agent and a hook talking to it at once.
 */

export interface ConnectionOptions {
  socketFile: string;
  /** How long to wait for a reply before giving up on a request. */
  requestTimeoutMs?: number;
  onEvent?: (name: DaemonEventName, payload: unknown) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class DaemonConnection {
  private readonly socket: Socket;
  private readonly decoder = new MessageDecoder();
  private readonly pending = new Map<RequestId, Pending>();
  private readonly timeoutMs: number;
  private nextId = 1;
  private closed = false;
  private closeReason: string | undefined;

  private constructor(
    socket: Socket,
    private readonly options: ConnectionOptions,
  ) {
    this.socket = socket;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("close", () => this.fail("daemon closed the connection"));
    socket.on("error", (error) => this.fail(error.message));
  }

  static connect(options: ConnectionOptions): Promise<DaemonConnection> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(options.socketFile);
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        resolve(new DaemonConnection(socket, options));
      });
      socket.once("error", (error) => {
        socket.destroy();
        reject(error);
      });
    });
  }

  /**
   * Exchange versions before anything else.
   *
   * A daemon started by yesterday's build is still listening today, and a
   * mismatch has to surface here as a clear message rather than later as a
   * field that is mysteriously missing.
   */
  async hello(): Promise<HandshakeResult> {
    const result = (await this.request(HANDSHAKE_METHOD)) as HandshakeResult;
    const verdict = checkVersions(result);
    if (!verdict.compatible) {
      throw new RpcClientError(
        RPC_VERSION_MISMATCH,
        `Incompatible daemon: ${verdict.reason}. ` +
          `Run \`drumlin daemon stop\` and try again.`,
      );
    }
    return result;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(
        new RpcClientError(
          RPC_INTERNAL_ERROR,
          this.closeReason ?? "connection is closed",
        ),
      );
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcClientError(
            RPC_INTERNAL_ERROR,
            `${method} did not answer within ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      this.write(rpcRequest(id, method, params));
    });
  }

  /** Send without waiting. Used by the edit hook, which must not block. */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write(rpcNotification(method, params));
  }

  async subscribe(root: string, events?: DaemonEventName[]): Promise<void> {
    await this.request(SUBSCRIBE_METHOD, events ? { root, events } : { root });
  }

  /**
   * Hang up, failing anything still in flight.
   *
   * Rejecting rather than dropping the pending requests is the whole point.
   * A cleared map leaves the caller awaiting a promise that will never settle,
   * and the symptom is a command that prints nothing and exits — which is
   * indistinguishable from the daemon being broken.
   */
  close(reason = "connection closed while the request was in flight"): void {
    if (this.closed) {
      this.socket.destroy();
      return;
    }
    this.fail(reason);
    this.socket.destroy();
  }

  private write(message: RpcMessage): void {
    this.socket.write(encodeMessage(message));
  }

  private receive(chunk: string): void {
    const { messages } = this.decoder.push(chunk);

    for (const message of messages) {
      if (isNotification(message)) {
        this.options.onEvent?.(
          message.method as DaemonEventName,
          message.params,
        );
        continue;
      }
      if (!isResponse(message)) continue;

      const id = (message as { id: RequestId | null }).id;
      if (id === null) continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);

      if (isFailure(message)) {
        pending.reject(
          new RpcClientError(
            message.error.code,
            message.error.message,
            message.error.data,
          ),
        );
        continue;
      }
      pending.resolve((message as { result: unknown }).result);
    }
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RpcClientError(RPC_INTERNAL_ERROR, reason));
    }
    this.pending.clear();
  }
}
