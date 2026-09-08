#!/usr/bin/env node
/**
 * The executable entry point.
 *
 * Separate from `main.ts` because that module exports `main` without calling
 * it, which is what lets the tests drive a daemon in-process. Something still
 * has to invoke it for the built binary, and a checked-in module does that
 * where it can be typechecked, rather than a string inside the build script.
 */
import { main } from "./main.js";

await main(process.argv.slice(2));
