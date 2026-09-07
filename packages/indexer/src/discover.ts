import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

/**
 * Directories that must never be walked.
 *
 * Build output is the dangerous one: `.next/server/pages` looks exactly like a
 * Pages Router source tree, so a naive walk invents hundreds of phantom screens
 * and doubles every real one. `.claude/worktrees` is the same hazard via a
 * different route — full copies of the repo nested inside it.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  ".vercel",
  ".svelte-kit",
  ".cache",
  "dist",
  "build",
  "out",
  "coverage",
  "storybook-static",
  ".claude",
  ".cursor",
  "__snapshots__",
]);

export function isIgnoredPath(path: string): boolean {
  return path
    .split(sep)
    .some((segment) => IGNORED_DIRECTORIES.has(segment));
}

const ANALYZABLE = /\.(tsx|ts|jsx|js|mjs|cjs)$/;

/**
 * Whether a path is one this indexer would have parsed in the first place.
 *
 * Kept here, beside `isIgnoredPath`, rather than next to the ts-morph project
 * it describes. It is a string test, and importing it should not cost the
 * caller a parser: the `afterFileEdit` hook calls this and nothing else from
 * the indexer, on every write an agent makes.
 */
export function isAnalyzableSource(path: string): boolean {
  if (path.endsWith(".d.ts")) return false;
  if (!ANALYZABLE.test(path)) return false;
  return !isIgnoredPath(path);
}

/** A single Next.js application root, which may sit inside a monorepo. */
export interface NextApp {
  /** Absolute path to the directory holding next.config.*. */
  root: string;
  /** Absolute path to the App Router directory, when present. */
  appDir?: string;
  /** Absolute path to the Pages Router directory, when present. */
  pagesDir?: string;
  /** Absolute path to components.json, when the project uses shadcn/ui. */
  shadcnConfig?: string;
  /** Router style actually present on disk. */
  router: "app" | "pages" | "mixed";
}

const CONFIG_NAMES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
];

function firstExisting(...candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

/** Resolve one Next.js app from a directory known to contain a Next config. */
export function describeApp(root: string): NextApp | undefined {
  const absolute = resolve(root);
  const appDir = firstExisting(join(absolute, "src", "app"), join(absolute, "app"));
  const pagesDir = firstExisting(
    join(absolute, "src", "pages"),
    join(absolute, "pages"),
  );

  if (!appDir && !pagesDir) return undefined;

  const router: NextApp["router"] =
    appDir && pagesDir ? "mixed" : appDir ? "app" : "pages";

  const app: NextApp = { root: absolute, router };
  if (appDir) app.appDir = appDir;
  if (pagesDir) app.pagesDir = pagesDir;

  const shadcn = firstExisting(join(absolute, "components.json"));
  if (shadcn) app.shadcnConfig = shadcn;

  return app;
}

/**
 * Find Next.js applications at or beneath `root`.
 *
 * Monorepos are the normal case, not the exception, so this returns every app it
 * finds rather than assuming one. A caller with more than one result should make
 * the user choose instead of guessing.
 */
export function findApps(root: string, maxDepth = 4): NextApp[] {
  const absolute = resolve(root);
  const found: NextApp[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    if (entries.some((entry) => CONFIG_NAMES.includes(entry))) {
      const app = describeApp(dir);
      if (app) {
        found.push(app);
        // A nested app inside an app is not a thing worth supporting; stop here
        // so `src/app` is never mistaken for a second application root.
        return;
      }
    }

    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) walk(full, depth + 1);
      } catch {
        // Unreadable or a broken symlink; skipping is correct.
      }
    }
  };

  walk(absolute, 0);
  return found;
}

/** Repository-relative POSIX path. Identity must survive a clone. */
export function relativePath(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

export function isRouteGroup(segment: string): boolean {
  return segment.startsWith("(") && segment.endsWith(")");
}

/** `@parallel` slots and route groups organise files without changing the URL. */
export function isNonUrlSegment(segment: string): boolean {
  return isRouteGroup(segment) || segment.startsWith("@");
}

export function isPrivateSegment(segment: string): boolean {
  return segment.startsWith("_");
}

export function fileStem(file: string): string {
  return basename(file).replace(/\.(tsx|ts|jsx|js|mjs|cjs)$/, "");
}
