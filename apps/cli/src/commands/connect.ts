import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPlugin, PLUGIN_NAME } from "@drumlin/cursor";
import { flagBoolean, flagString, type ParsedArgs } from "../args.js";

/**
 * `drumlin connect cursor` — installing the plugin.
 *
 * Writes a Cursor plugin into `~/.cursor/plugins/local/drumlin/`. Generated
 * rather than copied because two of the values are machine-specific: where this
 * checkout lives and which Node runs it.
 *
 * Local plugin imports sit behind a dashboard setting. The installer explains
 * that rather than failing on it — there is nothing it can do about the setting,
 * and a command that writes the files correctly and then reports "failed" is
 * worse than one that says what is left to do.
 */

const USAGE = `drumlin connect <cursor>

  cursor    Install the Drumlin plugin into ~/.cursor/plugins/local/

Options
  --dry-run    Print what would be written, without writing it
  --force      Overwrite an existing installation
  --dir <path> Install somewhere else
`;

export async function connectCommand(
  args: ParsedArgs,
  _cwd: string,
): Promise<number> {
  const [host] = args.positional;

  if (host !== "cursor") {
    process.stderr.write(
      host ? `No adapter for ${host}.\n\n${USAGE}` : USAGE,
    );
    return host ? 1 : 0;
  }

  const targets = resolveTargets();
  if (!targets) {
    process.stderr.write(
      "Could not locate the drumlin entry points. Is this a complete checkout?\n",
    );
    return 1;
  }

  const files = buildPlugin(targets);
  const directory = flagString(args, "dir") ?? defaultPluginDir();
  const dryRun = flagBoolean(args, "dry-run", false);
  const force = flagBoolean(args, "force", false);

  if (dryRun) {
    process.stdout.write(`Would write to ${directory}\n\n`);
    for (const file of files) {
      process.stdout.write(`--- ${file.path}\n${file.contents}\n`);
    }
    return 0;
  }

  const manifest = join(directory, ".cursor-plugin", "plugin.json");
  const reinstalling = existsSync(manifest);
  if (reinstalling && !force && !isOurs(manifest)) {
    process.stderr.write(
      `${directory} already holds a different plugin. Use --force to replace it.\n`,
    );
    return 1;
  }

  for (const file of files) {
    const path = join(directory, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents, "utf8");
  }

  process.stdout.write(
    `${reinstalling ? "Updated" : "Installed"} the Drumlin plugin\n` +
      `  ${directory}\n\n` +
      `  hooks    workspaceOpen, sessionStart, afterFileEdit, stop\n` +
      `  mcp      drumlin (stdio, four read-only tools)\n` +
      `  skill    drumlin\n\n` +
      `Installing it does not switch it on anywhere.\n` +
      `These hooks fire in every workspace you open, so each project\n` +
      `decides for itself. Two steps left:\n\n` +
      `  1. Local plugin imports are behind a setting. Turn on\n` +
      `     "Allow local plugin imports" in Cursor's dashboard, then\n` +
      `     restart Cursor so it picks up the hooks.\n\n` +
      `  2. In each project you want this in:\n` +
      `       drumlin init      # somewhere for issue IDs to live\n` +
      `       drumlin activate  # let it speak while you code\n\n` +
      `Everywhere else the hooks return immediately and do nothing.\n` +
      `Check it is live with \`drumlin daemon status\` after opening a workspace.\n`,
  );
  return 0;
}

/**
 * Where the CLI and the MCP server actually live.
 *
 * Resolved from the running program rather than from this module, because
 * there are two layouts and only one of them has modules on disk. Run from
 * source, this file sits at `apps/cli/src/commands/` and the entry point is
 * `apps/cli/bin/drumlin.mjs`. Run from a build, the whole CLI is one bundled
 * file and `import.meta.url` points at the bundle — so a path relative to this
 * module would land two directories from anywhere real.
 *
 * `process.argv[1]` is the entry point under both, which is also exactly what
 * the plugin should invoke. Its real path, so that a `drumlin` symlink on PATH
 * does not become the thing hooks depend on.
 */
function resolveTargets(): Parameters<typeof buildPlugin>[0] | undefined {
  const cliBin = realpathOf(process.argv[1] ?? "");
  if (!existsSync(cliBin)) return undefined;

  const mcpBin = resolveMcpBin(dirname(cliBin));
  if (!mcpBin) return undefined;

  const skill = readSkill(dirname(cliBin));
  if (skill === undefined) return undefined;

  return { node: stableNodePath(), cliBin, mcpBin, skill };
}

/**
 * The agent skill, from wherever this install keeps it.
 *
 * Copied into `dist/` by the build, so a built or published CLI carries its
 * own copy and does not reach back into a checkout that may not be there.
 */
function readSkill(cliDir: string): string | undefined {
  const candidates = [
    join(cliDir, "skills", "drumlin", "SKILL.md"),
    join(
      cliDir,
      "..",
      "..",
      "..",
      "integrations",
      "cursor",
      "skills",
      "drumlin",
      "SKILL.md",
    ),
    resolveQuietly("@drumlin/cursor/skill"),
  ];

  for (const path of candidates) {
    if (!path || !existsSync(path)) continue;
    try {
      return readFileSync(path, "utf8");
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The MCP server, whichever layout we are in.
 *
 * Tried in order rather than branched on a build-time flag, so that a checkout
 * which has been built and a checkout which has not both work, and neither
 * needs to know which it is.
 */
function resolveMcpBin(cliDir: string): string | undefined {
  const candidates = [
    // Built or installed: one package, all three executables together.
    join(cliDir, "drumlin-mcp.mjs"),
    // From source, via tsx: apps/cli/bin -> apps/mcp/bin.
    join(cliDir, "..", "..", "mcp", "bin", "drumlin-mcp.mjs"),
    // A workspace where the app is an ordinary dependency.
    resolveQuietly("@drumlin/mcp/bin"),
  ];

  return candidates.find((path) => path && existsSync(path));
}

function resolveQuietly(specifier: string): string | undefined {
  try {
    return fileURLToPath(import.meta.resolve(specifier));
  } catch {
    return undefined;
  }
}

/**
 * A path to Node that will still exist after the next upgrade.
 *
 * `process.execPath` under Homebrew is
 * `/opt/homebrew/Cellar/node/24.10.0/bin/node` — correct today and gone the
 * moment Node moves to 24.10.1, at which point every hook fails silently and
 * the plugin looks like it stopped working for no reason. nvm and Volta have
 * the same shape.
 *
 * So prefer a well-known symlink that resolves to the same binary. Comparing
 * real paths rather than versions is what makes this safe: the fallback is the
 * exact interpreter already running, never a different Node.
 */
function stableNodePath(): string {
  const actual = realpathOf(process.execPath);
  const candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && realpathOf(candidate) === actual) {
      return candidate;
    }
  }
  return process.execPath;
}

function realpathOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function defaultPluginDir(): string {
  return join(homedir(), ".cursor", "plugins", "local", PLUGIN_NAME);
}

function isOurs(manifest: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: string;
    };
    return parsed.name === PLUGIN_NAME;
  } catch {
    return false;
  }
}
