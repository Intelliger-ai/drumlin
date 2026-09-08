#!/usr/bin/env node
/**
 * The executable entry point.
 *
 * Separate from `server.ts` because that module exports `main` without calling
 * it, which is what lets the tests build a server and speak to it directly.
 * Something still has to invoke it for the built binary, and a checked-in
 * module does that where it can be typechecked.
 */
import { main } from "./server.js";

await main(process.argv.slice(2));
