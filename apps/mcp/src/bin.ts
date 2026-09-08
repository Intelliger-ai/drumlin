#!/usr/bin/env node
/**
 * The executable entry point.
 *
 * Separate from `server.ts` because that module exports `main` without calling
 * it, which is what lets the tests build a server and speak to it directly.
 * Something still has to invoke it for the built binary, and a checked-in
 * module does that where it can be typechecked.
 */
import { unsupportedNode } from "@drumlin/model/runtime";
import { main } from "./server.js";

// Cursor launches this one, so nobody is watching a terminal when it fails.
// Exiting with the reason on stderr is the only way the version reaches the
// editor's MCP log instead of a missing-module trace from inside the cache.
const unsupported = unsupportedNode(process.versions.node);
if (unsupported) {
  process.stderr.write(`${unsupported}\n`);
  process.exit(1);
}

await main(process.argv.slice(2));
