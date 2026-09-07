#!/usr/bin/env node
/**
 * Entry point for `drumlind`.
 *
 * Mirrors apps/cli/bin/drumlin.mjs: the workspace ships TypeScript sources and
 * has no build step yet, so the tsx loader is registered before the import.
 */
import { register } from "tsx/esm/api";

register();

const { main } = await import("../src/main.ts");
await main(process.argv.slice(2));
