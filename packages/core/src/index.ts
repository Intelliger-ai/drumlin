/**
 * @drumlin/core — graph algorithms, the rule engine, and the issue state machine.
 *
 * Pure by contract: no filesystem, no parser, no IO. Enforced by
 * scripts/check-boundaries.mjs so that porting this to Rust stays a mechanical
 * translation rather than a rewrite. See vault/Decisions/DEC-0001 Core Language.md
 */
export * from "./graph/view.js";
export * from "./graph/reachability.js";
export * from "./graph/attribution.js";
export * from "./graph/identity.js";
export * from "./rules/types.js";
export * from "./rules/severity.js";
export * from "./rules/engine.js";
export * from "./rules/registry.js";
export * from "./issues/reconcile.js";
export * from "./issues/export.js";
export * from "./issues/retarget.js";
export * from "./issues/verify.js";
export * from "./runtime/diff.js";
export * from "./runtime/page.js";
export * from "./runtime/walk.js";
