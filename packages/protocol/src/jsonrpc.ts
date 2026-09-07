/**
 * JSON-RPC 2.0 envelopes.
 *
 * Hand-written rather than pulled from a library because the surface is three
 * message shapes and the framing is a newline, and a dependency here would sit
 * on the path between every client and the daemon.
 *
 * See Context/14 MCP and Local Daemon API.md
 */

export const JSONRPC_VERSION = "2.0";

export type RequestId = number | string;

export interface RpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  method: string;
  params?: unknown;
}

/** A request with no `id`: the caller does not want an answer. */
export interface RpcNotification {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcSuccess {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: typeof JSONRPC_VERSION;
  id: RequestId | null;
  error: RpcError;
}

export type RpcResponse = RpcSuccess | RpcFailure;
export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/**
 * Error codes.
 *
 * The negative range below -32000 is reserved by the spec for the transport
 * itself; Drumlin's own failures live in the -32001 and below application
 * range so a client can tell "the daemon could not parse that" apart from
 * "the workspace does not exist".
 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** The daemon and client disagree about the protocol version. */
export const RPC_VERSION_MISMATCH = -32001;
/** The request named a workspace the daemon has not opened. */
export const RPC_WORKSPACE_UNKNOWN = -32002;
/** The engine threw while handling an otherwise well-formed request. */
export const RPC_ENGINE_FAILED = -32003;

export function rpcRequest(
  id: RequestId,
  method: string,
  params?: unknown,
): RpcRequest {
  const request: RpcRequest = { jsonrpc: JSONRPC_VERSION, id, method };
  if (params !== undefined) request.params = params;
  return request;
}

export function rpcNotification(
  method: string,
  params?: unknown,
): RpcNotification {
  const notification: RpcNotification = { jsonrpc: JSONRPC_VERSION, method };
  if (params !== undefined) notification.params = params;
  return notification;
}

export function rpcSuccess(id: RequestId, result: unknown): RpcSuccess {
  return { jsonrpc: JSONRPC_VERSION, id, result };
}

export function rpcFailure(
  id: RequestId | null,
  code: number,
  message: string,
  data?: unknown,
): RpcFailure {
  const error: RpcError = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: JSONRPC_VERSION, id, error };
}

export function isRequest(message: RpcMessage): message is RpcRequest {
  return "method" in message && "id" in message && message.id !== null;
}

export function isNotification(
  message: RpcMessage,
): message is RpcNotification {
  return "method" in message && !("id" in message);
}

export function isFailure(message: RpcMessage): message is RpcFailure {
  return "error" in message;
}

export function isResponse(message: RpcMessage): message is RpcResponse {
  return "result" in message || "error" in message;
}

/**
 * Turn a caught value into an RPC error.
 *
 * Deliberately keeps the message: a daemon that answers "internal error" to
 * everything is indistinguishable from a broken one, and the client here is
 * always the same user on the same machine, so there is nothing to leak to.
 */
export function toRpcError(error: unknown, code = RPC_ENGINE_FAILED): RpcError {
  if (error instanceof Error) {
    const rpc: RpcError = { code, message: error.message };
    if (error.stack) rpc.data = { stack: error.stack };
    return rpc;
  }
  return { code, message: String(error) };
}

/** An RPC failure raised locally, so a client can rethrow it as an Error. */
export class RpcClientError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcClientError";
  }
}
