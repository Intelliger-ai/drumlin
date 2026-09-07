#!/usr/bin/env node
/**
 * Entry point for a globally linked `drumlin`.
 *
 * The workspace ships TypeScript sources and has no build step yet, so this
 * registers the tsx loader before importing the CLI. When there is a build,
 * this file collapses to a plain import of the compiled entry.
 */
import { register } from "tsx/esm/api";

register();

const { main } = await import("../src/cli.ts");
await main();
