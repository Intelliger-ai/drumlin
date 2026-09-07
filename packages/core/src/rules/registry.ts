import {
  duplicatePrimitive,
  selectOverload,
} from "./design-system.js";
import { deadEnd, orphan } from "./flow.js";
import { dropsSearchParams } from "./navigation.js";
import { destructiveNoConfirm, mutationNoFeedback } from "./mutation.js";
import {
  noErrorState,
  noLoadingState,
  noNotFoundState,
} from "./state.js";
import type { Rule } from "./types.js";

/**
 * The Milestone A rule set.
 *
 * Ten rules, all deterministic or structural — no model judgement anywhere.
 * Rules about roles and permissions are deliberately absent: Drumlin can see
 * that a route checks a role but not which roles should reach it, so those are
 * a context-confirmation target instead. See `drumlin context`.
 */
export const MILESTONE_A_RULES: readonly Rule[] = [
  // State completeness
  noLoadingState,
  noErrorState,
  noNotFoundState,
  // Graph structure
  deadEnd,
  orphan,
  // Context preservation
  dropsSearchParams,
  // Design system
  duplicatePrimitive,
  selectOverload,
  // Mutation safety
  mutationNoFeedback,
  destructiveNoConfirm,
];

export function rulesById(
  ids: readonly string[] | undefined,
  all: readonly Rule[] = MILESTONE_A_RULES,
): Rule[] {
  if (!ids || ids.length === 0) return [...all];
  const wanted = new Set(ids);
  return all.filter((rule) => wanted.has(rule.id));
}
