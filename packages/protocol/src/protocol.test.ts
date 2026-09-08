import { describe, expect, it } from "vitest";
import { IR_SCHEMA_VERSION } from "@drumlin/model";
import {
  checkVersions,
  encodeMessage,
  handshakeResult,
  isFailure,
  isNotification,
  isRequest,
  MessageDecoder,
  PROTOCOL_VERSION,
  rpcFailure,
  rpcNotification,
  rpcRequest,
  rpcSuccess,
  RPC_METHOD_NOT_FOUND,
  toRpcError,
} from "./index.js";

describe("ndjson framing", () => {
  it("round-trips every message shape", () => {
    const sent = [
      rpcRequest(1, "graph.get", { root: "/tmp/app" }),
      rpcSuccess(1, { cached: true }),
      rpcFailure(2, RPC_METHOD_NOT_FOUND, "no such method"),
      rpcNotification("graph.updated", { workspace: "/tmp/app", revision: 3 }),
    ];

    const decoder = new MessageDecoder();
    const { messages, errors } = decoder.push(sent.map(encodeMessage).join(""));

    expect(errors).toEqual([]);
    expect(messages).toEqual(sent);
  });

  it("reassembles a message split across chunks", () => {
    const wire = encodeMessage(rpcRequest("a", "check.run", { root: "/x" }));
    const decoder = new MessageDecoder();

    const half = Math.floor(wire.length / 2);
    expect(decoder.push(wire.slice(0, half)).messages).toEqual([]);
    expect(decoder.pending).toBeGreaterThan(0);

    const { messages } = decoder.push(wire.slice(half));
    expect(messages).toHaveLength(1);
    expect(decoder.pending).toBe(0);
  });

  it("splits several messages arriving in one chunk", () => {
    const wire =
      encodeMessage(rpcRequest(1, "a")) + encodeMessage(rpcRequest(2, "b"));
    const { messages } = new MessageDecoder().push(wire);
    expect(
      messages.map((message) => (message as { method: string }).method),
    ).toEqual(["a", "b"]);
  });

  it("survives a payload containing newlines", () => {
    const message = rpcSuccess(1, { message: "line one\nline two\n" });
    const { messages, errors } = new MessageDecoder().push(
      encodeMessage(message),
    );
    expect(errors).toEqual([]);
    expect(messages).toEqual([message]);
  });

  it("reports a malformed line without losing the good ones around it", () => {
    const wire =
      encodeMessage(rpcRequest(1, "a")) +
      "{not json\n" +
      "[1,2,3]\n" +
      encodeMessage(rpcRequest(2, "b"));

    const { messages, errors } = new MessageDecoder().push(wire);

    expect(messages).toHaveLength(2);
    expect(errors).toHaveLength(2);
    expect(errors[1]?.message).toBe("Message is not a JSON object");
  });
});

describe("message discrimination", () => {
  it("tells requests, notifications, and failures apart", () => {
    expect(isRequest(rpcRequest(1, "a"))).toBe(true);
    expect(isRequest(rpcNotification("a"))).toBe(false);
    expect(isNotification(rpcNotification("a"))).toBe(true);
    expect(isNotification(rpcRequest(1, "a"))).toBe(false);
    expect(isFailure(rpcFailure(1, -1, "x"))).toBe(true);
    expect(isFailure(rpcSuccess(1, {}))).toBe(false);
  });

  it("keeps the message when converting a thrown error", () => {
    const rpc = toRpcError(new Error("no app/ directory"));
    expect(rpc.message).toBe("no app/ directory");
  });
});

describe("handshake", () => {
  it("accepts a daemon on the same protocol and IR schema", () => {
    const verdict = checkVersions(
      handshakeResult("0.1.0", new Date().toISOString()),
    );
    expect(verdict.compatible).toBe(true);
  });

  it("rejects a daemon on a different protocol version", () => {
    const result = handshakeResult("0.1.0", new Date().toISOString());
    const verdict = checkVersions({
      ...result,
      protocolVersion: PROTOCOL_VERSION + 1,
    });
    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toContain("protocol");
  });

  it("rejects a daemon building a different IR schema", () => {
    const result = handshakeResult("0.1.0", new Date().toISOString());
    const verdict = checkVersions({
      ...result,
      irSchemaVersion: IR_SCHEMA_VERSION + 1,
    });
    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toContain("IR schema");
  });
});
