#!/usr/bin/env node
/**
 * Speak MCP to the server over a real pipe.
 *
 * The unit tests call the tool functions directly, which proves the logic and
 * nothing about the wiring. This checks the parts only a subprocess can: that
 * the binary starts, that the handshake completes, that `tools/list` returns
 * the four tools, and — most easily broken — that nothing writes stray output
 * to stdout, which corrupts the JSON-RPC stream and makes the server look
 * broken to the host for reasons invisible from inside.
 *
 * Usage: node scripts/probe-mcp.mjs <workspace>
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Required rather than defaulted to cwd: this repo is not a Next.js app, so a
// bare run would always fail, and it would fail inside the first tool call
// where it reads like a broken server.
if (!process.argv[2]) {
  console.error("Usage: node scripts/probe-mcp.mjs <app-path>");
  process.exit(1);
}

const root = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../apps/mcp/bin/drumlin-mcp.mjs");

const child = spawn(process.execPath, [entry, "--root", root], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, DRUMLIN_ROOT: root },
});

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const pending = new Map();
let buffer = "";
let nextId = 1;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      fail(`stdout is not JSON-RPC — the stream is corrupted by: ${line}`);
      return;
    }
    const settle = pending.get(message.id);
    if (settle) {
      pending.delete(message.id);
      settle(message);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  return new Promise((settle, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${method} timed out`)),
      20_000,
    );
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else settle(message.result);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

function fail(message) {
  console.error(`FAIL  ${message}`);
  if (stderr.trim()) console.error(stderr.trim());
  child.kill();
  process.exit(1);
}

const EXPECTED = [
  "drumlin_project_summary",
  "drumlin_get_flow",
  "drumlin_get_issue",
  "drumlin_check_changed",
];

try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "drumlin-probe", version: "0" },
  });
  console.log(`handshake   ${init.serverInfo.name} ${init.serverInfo.version}`);
  notify("notifications/initialized", {});

  const { tools } = await send("tools/list", {});
  const names = tools.map((tool) => tool.name);
  console.log(`tools/list  ${names.join(", ")}`);

  if (names.length !== EXPECTED.length || !EXPECTED.every((n) => names.includes(n))) {
    fail(`expected exactly ${EXPECTED.join(", ")}`);
  }
  for (const tool of tools) {
    if (tool.annotations?.readOnlyHint !== true) {
      fail(`${tool.name} is not declared read-only`);
    }
  }

  const summary = await send("tools/call", {
    name: "drumlin_project_summary",
    arguments: {},
  });
  const text = summary.content?.[0]?.text ?? "";
  console.log(`summary     ${text.split("\n")[0]}`);
  if (summary.isError) fail(`project_summary errored: ${text}`);

  const changed = await send("tools/call", {
    name: "drumlin_check_changed",
    arguments: { severity: "high" },
  });
  console.log(`changed     ${(changed.content?.[0]?.text ?? "").split("\n")[0]}`);

  // An unknown route must come back as tool content, not as a protocol error:
  // the agent can act on a message and cannot act on a transport failure.
  const missing = await send("tools/call", {
    name: "drumlin_get_flow",
    arguments: { route: "/definitely-not-a-route" },
  });
  if (!missing.isError) fail("an unknown route should be reported as a tool error");
  console.log(`error path  ${(missing.content?.[0]?.text ?? "").split("\n")[0]}`);

  console.log("\nok — server speaks MCP over stdio and exposes four read-only tools");
  child.kill();
  process.exit(0);
} catch (error) {
  fail(error.message);
}
