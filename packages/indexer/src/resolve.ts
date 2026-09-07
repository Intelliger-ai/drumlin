import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Import specifier resolution.
 *
 * Type resolution is off (see `createProject`), so imports have to be resolved
 * by path arithmetic instead. This matters more than it sounds: chrome
 * navigation lives in components a layout imports, and on a real app those
 * imports are aliased (`@/components/layout/navbar`) and default-exported.
 * Matching on exported names instead missed both, which made every page linked
 * only from the site header look unreachable.
 */

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs"] as const;

export interface PathAlias {
  /** Prefix before any `*`, e.g. `@/`. */
  prefix: string;
  /** Directories the prefix maps to, absolute. */
  targets: string[];
}

/**
 * Read `compilerOptions.paths` from the nearest tsconfig.
 *
 * Hand-parsed rather than resolved through the TypeScript API because tsconfigs
 * in the wild contain comments and trailing commas, and a throw here would take
 * out the whole index for a file that is only an optimisation.
 */
export function readPathAliases(root: string): PathAlias[] {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;

    try {
      const config = parseJsonc(readFileSync(file, "utf8")) as {
        compilerOptions?: {
          baseUrl?: string;
          paths?: Record<string, string[]>;
        };
      };
      const options = config.compilerOptions;
      if (!options?.paths) continue;

      const base = resolve(root, options.baseUrl ?? ".");
      const aliases: PathAlias[] = [];

      for (const [pattern, targets] of Object.entries(options.paths)) {
        const prefix = pattern.replace(/\*$/, "");
        aliases.push({
          prefix,
          targets: targets.map((target) =>
            resolve(base, target.replace(/\*$/, "")),
          ),
        });
      }

      // Longest prefix first, so `@/components/` wins over `@/`.
      return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
    } catch {
      continue;
    }
  }

  return [];
}

/** Aliases assumed when a project declares none, covering the common defaults. */
export function defaultAliases(root: string): PathAlias[] {
  const targets = [join(root, "src"), root];
  return ["@/", "~/", "#/"].map((prefix) => ({ prefix, targets }));
}

export interface ImportResolver {
  (fromFile: string, specifier: string): string | undefined;
}

/**
 * Build a resolver over a known set of files.
 *
 * Resolution is confined to files that were actually parsed, so a specifier
 * pointing into `node_modules` or at an asset simply fails rather than
 * returning a path nothing can be read from.
 */
export function createImportResolver(
  root: string,
  files: Iterable<string>,
): ImportResolver {
  const known = new Set<string>();
  for (const file of files) known.add(file);

  const declared = readPathAliases(root);
  const aliases = declared.length > 0 ? declared : defaultAliases(root);

  const firstExisting = (base: string): string | undefined => {
    if (known.has(base)) return base;
    for (const extension of EXTENSIONS) {
      const candidate = `${base}${extension}`;
      if (known.has(candidate)) return candidate;
    }
    for (const extension of EXTENSIONS) {
      const candidate = join(base, `index${extension}`);
      if (known.has(candidate)) return candidate;
    }
    return undefined;
  };

  return (fromFile, specifier) => {
    if (specifier.startsWith(".")) {
      return firstExisting(resolve(dirname(fromFile), specifier));
    }

    if (isAbsolute(specifier)) return firstExisting(specifier);

    for (const alias of aliases) {
      if (!specifier.startsWith(alias.prefix)) continue;
      const rest = specifier.slice(alias.prefix.length);
      for (const target of alias.targets) {
        const found = firstExisting(join(target, rest));
        if (found) return found;
      }
    }

    // A bare specifier is a package. Nothing local to follow.
    return undefined;
  };
}

/** Strip comments and trailing commas so a tsconfig written by hand still parses. */
function parseJsonc(text: string): unknown {
  let output = "";
  let inString = false;
  let quote = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];

    if (inString) {
      output += char;
      if (char === "\\") {
        output += next ?? "";
        index += 2;
        continue;
      }
      if (char === quote) inString = false;
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
      }
      index += 2;
      continue;
    }

    output += char;
    index += 1;
  }

  return JSON.parse(output.replace(/,(\s*[}\]])/g, "$1"));
}
