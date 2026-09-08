import { readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The installed version, read rather than baked in.
 *
 * `drumlin --version` used to print the usage text, because no flag handled it
 * and the usage was the fallback for anything unrecognised. That is a bad first
 * impression and it makes a bug report unanswerable: the first question about
 * any report is which version, and there was no way to ask.
 *
 * Read from the nearest manifest at runtime instead of substituted at build
 * time, because the build is not the only way this runs. A contributor running
 * from source through `tsx` has no build step, and a version injected by
 * `esbuild` would leave them printing whatever the last build said.
 *
 * `import.meta.url` is the anchor because it is a real file in every layout —
 * `src/` under `tsx`, `dist/` once bundled, the installed directory once
 * published — and walking up from any of them reaches that layout's own
 * manifest.
 */
export function version(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return versionNear(here) ?? "unknown";
}

/**
 * Walk up for the manifest that describes *us*.
 *
 * The name check is the point. Under a test runner, or from anywhere inside a
 * `node_modules` tree, the nearest `package.json` belongs to something else,
 * and reporting its version would be worse than reporting nothing: it would be
 * confidently wrong. So only a Drumlin manifest counts, and the walk continues
 * past anything else.
 */
export function versionNear(start: string): string | undefined {
  const stop = parse(start).root;
  let dir = start;

  for (;;) {
    const manifest = read(join(dir, "package.json"));
    if (manifest && isDrumlin(manifest.name) && manifest.version) {
      return manifest.version;
    }

    if (dir === stop) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isDrumlin(name: unknown): boolean {
  return (
    typeof name === "string" &&
    (name === "drumlin" || name.startsWith("@drumlin/"))
  );
}

function read(path: string): { name?: unknown; version?: string } | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;

    const record = parsed as Record<string, unknown>;
    return {
      name: record["name"],
      ...(typeof record["version"] === "string"
        ? { version: record["version"] }
        : {}),
    };
  } catch {
    return undefined;
  }
}
