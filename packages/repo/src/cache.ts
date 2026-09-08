import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { IR_SCHEMA_VERSION, type GraphDocument } from "@drumlin/model";

/**
 * The derived cache.
 *
 * Holds nothing that cannot be rebuilt from the repository, which is what makes
 * `rm -rf .drumlin/cache` a safe instruction rather than data loss. Uses the
 * built-in `node:sqlite`, so there is no native module to compile.
 */

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
};

/**
 * `node:sqlite` is still flagged experimental and prints a warning on import.
 * Silencing it around just this import keeps the CLI's output clean without
 * hiding warnings from anything else.
 */
async function loadSqlite(): Promise<new (path: string) => SqliteDatabase> {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    const module = await import("node:sqlite");
    return module.DatabaseSync as unknown as new (
      path: string,
    ) => SqliteDatabase;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ir_cache (
  key            TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  payload        TEXT NOT NULL
);
`;

export interface CacheKeyInput {
  /** Absolute directories whose contents determine the IR. */
  directories: string[];
  /** Extra values that should invalidate the entry, e.g. the app root. */
  salt?: string[];
}

const RELEVANT_EXTENSIONS = new Set([".tsx", ".ts", ".jsx", ".js"]);

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  ".turbo",
  ".vercel",
  "dist",
  "build",
  "out",
  "coverage",
]);

/**
 * Fingerprint the inputs to extraction.
 *
 * Uses path, size, and mtime rather than file contents: reading every file to
 * hash it costs about as much as re-indexing, which would defeat the cache.
 */
export function computeCacheKey(input: CacheKeyInput): string {
  const hash = createHash("sha256");
  hash.update(`schema:${IR_SCHEMA_VERSION}`);
  for (const value of input.salt ?? []) hash.update(`salt:${value}`);

  const entries: string[] = [];

  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRECTORIES.has(name)) continue;
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      const dot = name.lastIndexOf(".");
      if (dot === -1) continue;
      if (!RELEVANT_EXTENSIONS.has(name.slice(dot))) continue;
      entries.push(`${full}:${stats.size}:${Math.floor(stats.mtimeMs)}`);
    }
  };

  for (const dir of [...input.directories].sort()) walk(dir);
  for (const entry of entries) hash.update(entry);

  return hash.digest("hex");
}

export class DerivedCache {
  private constructor(private readonly db: SqliteDatabase) {}

  static async open(dbFile: string): Promise<DerivedCache> {
    mkdirSync(dirname(dbFile), { recursive: true });
    const DatabaseSync = await loadSqlite();
    const db = new DatabaseSync(dbFile);
    db.exec(SCHEMA);
    return new DerivedCache(db);
  }

  getGraph(key: string): GraphDocument | undefined {
    const row = this.db
      .prepare(
        "SELECT payload FROM ir_cache WHERE key = ? AND schema_version = ?",
      )
      .get(key, IR_SCHEMA_VERSION) as { payload?: string } | undefined;
    if (!row?.payload) return undefined;
    try {
      return JSON.parse(row.payload) as GraphDocument;
    } catch {
      // A corrupt entry is a cache miss, never an error: the whole point of a
      // derived layer is that losing it costs only time.
      return undefined;
    }
  }

  putGraph(key: string, graph: GraphDocument): void {
    this.db
      .prepare(
        `INSERT INTO ir_cache (key, schema_version, created_at, payload)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           created_at = excluded.created_at,
           payload    = excluded.payload`,
      )
      .run(
        key,
        IR_SCHEMA_VERSION,
        new Date().toISOString(),
        JSON.stringify(graph),
      );
  }

  close(): void {
    this.db.close();
  }
}
