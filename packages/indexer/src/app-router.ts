import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { routeToScreenId, stateId, type StateKind } from "@drumlin/model";
import {
  IGNORED_DIRECTORIES,
  isNonUrlSegment,
  isPrivateSegment,
} from "./discover.js";
import { routeFromSegments } from "./routes.js";

/**
 * App Router file conventions, read off the filesystem before any parsing.
 *
 * Keeping the filesystem shape separate from the AST work matters because most
 * of what the App Router tells you about UX states is expressed as filenames,
 * not code.
 */

/** Convention files that declare a UX state for a route segment. */
const STATE_FILES: Record<string, StateKind> = {
  loading: "loading",
  error: "error",
  "global-error": "error",
  "not-found": "not-found",
  forbidden: "forbidden",
  unauthorized: "forbidden",
};

const CONVENTION_FILES = [
  "page",
  "layout",
  "template",
  "route",
  "default",
  ...Object.keys(STATE_FILES),
];

const EXTENSIONS = ["tsx", "ts", "jsx", "js"];

export interface AppSegment {
  /** Absolute directory path. */
  dir: string;
  /** Raw directory names from the app root, groups and slots included. */
  rawSegments: string[];
  /** URL path this segment corresponds to. */
  route: string;
  /** Convention file name to absolute path. */
  files: Map<string, string>;
  /** Index into the walk order of the parent segment, or -1 at the root. */
  parent: number;
}

function findConventionFile(dir: string, name: string): string | undefined {
  for (const extension of EXTENSIONS) {
    const candidate = join(dir, `${name}.${extension}`);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not present.
    }
  }
  return undefined;
}

/** Walk the App Router tree, collecting one entry per route segment. */
export function collectAppSegments(appDir: string): AppSegment[] {
  const segments: AppSegment[] = [];

  const walk = (dir: string, rawSegments: string[], parent: number): void => {
    const files = new Map<string, string>();
    for (const name of CONVENTION_FILES) {
      const found = findConventionFile(dir, name);
      if (found) files.set(name, found);
    }

    const index = segments.length;
    segments.push({
      dir,
      rawSegments,
      route: routeFromSegments(rawSegments),
      files,
      parent,
    });

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      // `_components` and friends hold implementation, not routes.
      if (isPrivateSegment(entry)) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(full, [...rawSegments, entry], index);
    }
  };

  walk(appDir, [], -1);
  return segments;
}

/**
 * The nearest segment at or above `index` that declares a given convention file.
 *
 * This is what makes inherited boundaries correct: `app/loading.tsx` covers the
 * whole tree, so a nested route with no file of its own is still covered. Any
 * rule that ignored inheritance would report the entire product.
 */
export function nearestConventionFile(
  segments: readonly AppSegment[],
  index: number,
  name: string,
): { segment: AppSegment; index: number } | undefined {
  let current = index;
  while (current >= 0) {
    const segment = segments[current];
    if (!segment) return undefined;
    const file = segment.files.get(name);
    if (file) return { segment, index: current };
    current = segment.parent;
  }
  return undefined;
}

/** Route segments that render a page, i.e. real screens. */
export function screenSegments(
  segments: readonly AppSegment[],
): Array<{ segment: AppSegment; index: number }> {
  const screens: Array<{ segment: AppSegment; index: number }> = [];
  segments.forEach((segment, index) => {
    if (segment.files.has("page")) screens.push({ segment, index });
  });
  return screens;
}

/** Node ID for the state a convention file declares in a given segment. */
export function stateNodeId(segment: AppSegment, conventionName: string): string {
  const kind = STATE_FILES[conventionName] ?? conventionName;
  const screen = routeToScreenId(segment.route);
  return stateId(screen, kind);
}

export function stateKindFor(conventionName: string): StateKind | undefined {
  return STATE_FILES[conventionName];
}

export const STATE_CONVENTION_NAMES = Object.keys(STATE_FILES);

/** True when a segment is a parallel-route slot or a group rather than a path. */
export function isOrganisationalSegment(rawSegment: string): boolean {
  return isNonUrlSegment(rawSegment);
}
