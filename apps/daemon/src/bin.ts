#!/usr/bin/env node
/**
 * The executable entry point.
 *
 * Separate from `main.ts` because that module exports `main` without calling
 * it, which is what lets the tests drive a daemon in-process. Something still
 * has to invoke it for the built binary, and a checked-in module does that
 * where it can be typechecked, rather than a string inside the build script.
 */
import { unsupportedNode } from "@drumlin/model/runtime";
import { main } from "./main.js";

// The daemon is usually spawned, so a failure here surfaces as "auto-spawn did
// not work" rather than as its cause. Say the real reason on stderr, which the
// spawning CLI reports when a start fails.
const unsupported = unsupportedNode(process.versions.node);
if (unsupported) {
  process.stderr.write(`${unsupported}\n`);
  process.exit(1);
}

await main(process.argv.slice(2));
