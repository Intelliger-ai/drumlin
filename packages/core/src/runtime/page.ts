import type { ObservedControl, StateKind } from "@drumlin/model";

/**
 * What the walker needs from a browser, and nothing more.
 *
 * Playwright does not appear in this package and must not. Two reasons, and
 * the second is the one that matters.
 *
 * `packages/core` is pure — no IO, no parsers — and a boundary check enforces
 * it. But the deciding argument is that the walk is the part with the
 * judgement in it: which routes to try, what counts as settled, when to stop.
 * That logic is worth testing directly, and it cannot be if the only way to
 * run it is to start a browser. Behind this interface the walk is tested
 * against a scripted page in milliseconds.
 *
 * It also leaves room for the adapters the graph model was designed for —
 * XCUITest, Espresso, Maestro — which map the same UX contracts onto a
 * different driver. See vault/Runtime/Runtime Verification.md.
 */
export interface PageProbe {
  /**
   * Open a URL and wait for it to settle.
   *
   * "Settled" is the adapter's judgement, because only the driver knows what
   * it can observe. What this interface requires is that the result describes
   * one moment the adapter considered stable.
   */
  open(url: string): Promise<ProbeResult>;

  /**
   * Activate a control by accessible name, and report where that left us.
   *
   * By name rather than selector, because a selector is a fact about one
   * build's markup while an accessible name is what a user is looking for —
   * and the only identifier that survives a refactor well enough to compare
   * across runs.
   */
  activate(name: string): Promise<ProbeResult>;
}

export interface ProbeResult {
  /** Where the browser ended up, as a path. */
  url: string;
  status?: number;
  title?: string;
  /**
   * States seen while the page settled, in order.
   *
   * Ordered because the order carries information a set would lose:
   * `["loading", "empty"]` fetched and found nothing, while `["empty"]` alone
   * rendered empty before it had asked.
   */
  states: StateKind[];
  controls: ObservedControl[];
  errors: string[];
  artifact?: string;
}
