/**
 * @drumlin/model — canonical UX Graph IR domain types.
 *
 * Pure by contract: no filesystem, no parser, no IO. Enforced by
 * scripts/check-boundaries.mjs. See vault/Decisions/DEC-0001 Core Language.md
 */
export * from "./json.js";
export * from "./provenance.js";
export * from "./ids.js";
export * from "./graph.js";
export * from "./observed.js";
export * from "./findings.js";
export * from "./issues.js";
export * from "./caller.js";
export * from "./permissions.js";
export * from "./runtime.js";
