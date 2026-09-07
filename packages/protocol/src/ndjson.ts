import type { RpcMessage } from "./jsonrpc.js";

/**
 * Newline-delimited JSON framing.
 *
 * A socket hands you arbitrary chunks, so the only two failure modes worth
 * designing against are a message split across reads and several messages
 * arriving in one. The decoder is a buffer plus a split on newline, which
 * handles both without needing a length prefix.
 *
 * JSON cannot contain a raw newline outside a string, and `JSON.stringify`
 * escapes the ones inside strings, so a bare `\n` is an unambiguous terminator.
 */

export function encodeMessage(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** Raised for a line that is not JSON, or not a JSON object. */
export class FramingError extends Error {
  constructor(
    message: string,
    readonly line: string,
  ) {
    super(message);
    this.name = "FramingError";
  }
}

/**
 * Guard against a client that never sends a newline.
 *
 * Without a cap, a single malformed write grows the buffer until the daemon
 * dies, which turns a client bug into a denial of service against every other
 * client sharing the process.
 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

export class MessageDecoder {
  private buffer = "";

  /**
   * Feed a chunk and take whatever complete messages it produced.
   *
   * Malformed lines are returned as errors rather than thrown, because one bad
   * line must not discard the good messages that arrived in the same chunk.
   */
  push(chunk: string): { messages: RpcMessage[]; errors: FramingError[] } {
    this.buffer += chunk;

    if (this.buffer.length > MAX_LINE_BYTES && !this.buffer.includes("\n")) {
      const line = this.buffer;
      this.buffer = "";
      return {
        messages: [],
        errors: [
          new FramingError(
            `No newline in ${line.length} bytes; discarding buffer`,
            line.slice(0, 200),
          ),
        ],
      };
    }

    const messages: RpcMessage[] = [];
    const errors: FramingError[] = [];

    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");

      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        errors.push(
          new FramingError(
            error instanceof Error ? error.message : String(error),
            trimmed,
          ),
        );
        continue;
      }

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        errors.push(new FramingError("Message is not a JSON object", trimmed));
        continue;
      }

      messages.push(parsed as RpcMessage);
    }

    return { messages, errors };
  }

  /** Bytes buffered awaiting a newline. Exposed for tests and diagnostics. */
  get pending(): number {
    return this.buffer.length;
  }
}
