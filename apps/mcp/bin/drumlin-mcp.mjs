#!/usr/bin/env node
/**
 * Entry point for the stdio MCP server.
 *
 * Nothing may be written to stdout except MCP frames — the transport is stdout
 * — so this file stays silent and lets the server own the stream.
 */
import { register } from "tsx/esm/api";

register();

const { main } = await import("../src/server.ts");
await main(process.argv.slice(2));
