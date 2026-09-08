/**
 * Minimal argument parsing.
 *
 * Hand-rolled rather than pulled from a library because the surface is four
 * commands and six flags, and a dependency here would be the only thing in the
 * tree with an opinion about output.
 */

export interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");

      if (equals !== -1) {
        flags.set(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }

      // `--no-cache` sets `cache` false, which reads better at call sites than
      // checking for the presence of a negated flag name.
      if (body.startsWith("no-")) {
        flags.set(body.slice(3), false);
        continue;
      }

      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags.set(body, next);
        index += 1;
      } else {
        flags.set(body, true);
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      flags.set(token.slice(1), true);
      continue;
    }

    positional.push(token);
  }

  const [command, ...rest] = positional;
  return { command, positional: rest, flags };
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagBoolean(
  args: ParsedArgs,
  name: string,
  fallback: boolean,
): boolean {
  const value = args.flags.get(name);
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export type OutputFormat = "text" | "json";

export function outputFormat(args: ParsedArgs): OutputFormat {
  const value = flagString(args, "format") ?? "text";
  if (value !== "text" && value !== "json") {
    throw new Error(`Unknown --format ${value}. Expected text or json.`);
  }
  return value;
}
