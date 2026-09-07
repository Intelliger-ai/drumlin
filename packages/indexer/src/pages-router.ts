import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { StateKind } from "@drumlin/model";
import { IGNORED_DIRECTORIES, fileStem } from "./discover.js";

/**
 * Pages Router file conventions.
 *
 * The Pages Router has no per-route loading or error convention, so state
 * completeness for these screens has to be inferred from the component. That
 * asymmetry is exactly why the IR is router-agnostic: rules read Screen nodes
 * and never ask which router produced them.
 */

const PAGE_EXTENSIONS = new Set(["tsx", "ts", "jsx", "js"]);

/** Special files that are not routes. */
const NON_ROUTE_STEMS = new Set([
  "_app",
  "_document",
  "_error",
  "_middleware",
  "middleware",
]);

/** Whole-app fallbacks the Pages Router expresses as top-level files. */
const STATE_STEMS: Record<string, StateKind> = {
  "404": "not-found",
  "500": "error",
};

export interface PagesRoute {
  /** Absolute path to the page file. */
  file: string;
  /** URL path, with Next.js dynamic syntax intact. */
  route: string;
}

export interface PagesTree {
  routes: PagesRoute[];
  /** Top-level fallback screens, keyed by the state they represent. */
  states: Array<{ file: string; kind: StateKind }>;
  /** The custom App wrapper, when present. It is shared chrome. */
  appFile?: string;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index + 1);
}

/** Walk a Pages Router directory into routes and fallback states. */
export function collectPagesRoutes(pagesDir: string): PagesTree {
  const routes: PagesRoute[] = [];
  const states: PagesTree["states"] = [];
  let appFile: string | undefined;

  const walk = (dir: string, segments: string[]): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      const full = join(dir, entry);

      let isDirectory = false;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue;
      }

      if (isDirectory) {
        // API handlers are not screens.
        if (segments.length === 0 && entry === "api") continue;
        walk(full, [...segments, entry]);
        continue;
      }

      if (!PAGE_EXTENSIONS.has(extensionOf(entry))) continue;
      if (entry.endsWith(".d.ts")) continue;
      if (/\.(test|spec|stories)\.[a-z]+$/.test(entry)) continue;

      const stem = fileStem(entry);

      if (stem === "_app") {
        appFile = full;
        continue;
      }
      if (NON_ROUTE_STEMS.has(stem)) continue;

      const stateKind = segments.length === 0 ? STATE_STEMS[stem] : undefined;
      if (stateKind) {
        states.push({ file: full, kind: stateKind });
        continue;
      }

      const routeSegments =
        stem === "index" ? segments : [...segments, stem];
      const route =
        routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`;
      routes.push({ file: full, route });
    }
  };

  walk(pagesDir, []);
  return appFile ? { routes, states, appFile } : { routes, states };
}
