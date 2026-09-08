import { unsupportedNode } from "@drumlin/model/runtime";
import { flagBoolean, parseArgs, type ParsedArgs } from "./args.js";
import { version } from "./version.js";

/**
 * Commands are imported on demand.
 *
 * Not a style preference. Every hook Cursor fires is a fresh process, and a
 * static import list makes `drumlin hook file-edit` load the rule engine, the
 * indexer, and ts-morph in order to post one filename to a socket. Measured at
 * 380ms of startup against a 500ms budget, on the one hook that runs on every
 * write an agent makes.
 */

const USAGE = `drumlin — local-first UX intelligence

Usage
  drumlin <command> [options]

Commands
  help         Show this message
  init         Create .drumlin/ so issue IDs survive across runs
  activate     Let Drumlin report findings while you code, in this project
  deactivate   Silence the editor hooks and agent tools here
  graph        Dump the UX Graph IR as a readable outline or JSON
  check        Report UX findings
  context      Propose a role and permission model, and say what is unknown
  accept       Record a finding as an intentional deviation (human, at a tty)
  revoke       Undo an acceptance, or list what is currently silenced
  propose      Make the case for accepting one; a human decides
  decline      Turn down a proposal, leaving the issue open
  claim        Report a fix and have it checked
  verify       Re-derive from source; the only way to resolve an issue
  export       Write issues out for Linear or GitHub
  rules        List the active rules
  daemon       Manage the background daemon
  connect      Install the Drumlin plugin into a coding agent
  hook         Editor hook entry point; reads JSON on stdin

Options
  --app <path>       App to analyze; required when a monorepo holds several
  --format <fmt>     text (default) or json
  --no-cache         Re-index from source, ignoring the derived cache
  --no-daemon        Run in-process instead of using the daemon
  --changed [spec]   Report only findings from changed files (default: git)
  --observed <file>  check: diff a browser run you recorded against the source
  --limit <n>        Cap how much is listed
  --severity <s>     Only findings at this severity or above
  --rule <ids>       Comma-separated rule IDs to run
  --accepted         Include findings a human has accepted
  --fail-on <s>      Exit non-zero if a finding reaches this severity
  --write            context: save the proposal as inferred
  --confirm          context: record the proposal as confirmed by a human
  --reason <text>    accept/propose/revoke: why the decision is what it is
  --note <text>      claim: what you changed
  --no-verify        claim: record it without checking it now
  --to <target>      export: linear, github, or markdown
  --out <file>       export: write to a file instead of stdout
  --new              export: only issues not yet sent to that target
  -h, --help         Show this message
  -v, --version      Print the version
`;

/** Commands whose authority comes from the terminal they were typed into. */
const HUMAN_ONLY = new Set(["accept"]);

async function rulesCommand(): Promise<number> {
  const { MILESTONE_A_RULES } = await import("@drumlin/core");
  const lines = [`${MILESTONE_A_RULES.length} active rules`, ""];
  for (const rule of MILESTONE_A_RULES) {
    lines.push(`${rule.id}`);
    lines.push(`  ${rule.severity} · ${rule.classification} · ${rule.scope}`);
    lines.push(`  ${rule.summary}`);
    lines.push("");
  }
  process.stdout.write(lines.join("\n"));
  return 0;
}

/**
 * Commands that never need to look at a repository.
 *
 * Kept apart so they do not start a daemon as a side effect. `drumlin rules`
 * spinning up a background process that parses an app would be absurd, and
 * `drumlin daemon stop` doing it would be worse.
 */
async function runWithoutEngine(
  command: string,
  args: ParsedArgs,
  cwd: string,
): Promise<number | undefined> {
  switch (command) {
    case "rules":
      return rulesCommand();
    case "daemon": {
      const { daemonCommand } = await import("./commands/daemon.js");
      return daemonCommand(args);
    }
    case "connect": {
      const { connectCommand } = await import("./commands/connect.js");
      return connectCommand(args, cwd);
    }
    default:
      return undefined;
  }
}

export async function run(
  argv: readonly string[],
  cwd: string,
): Promise<number> {
  const args = parseArgs(argv);

  // Asking for the version or the help is a successful use of the tool, so it
  // exits 0. `drumlin --help` used to exit 1, which is enough to fail a CI
  // step whose whole job is checking the thing installed.
  if (args.flags.has("version") || args.flags.has("v")) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (args.flags.has("help") || args.flags.has("h") || args.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  // Bare `drumlin` is the one usage-printing case that is not a request: the
  // caller has not said what they want, so it stays non-zero.
  if (!args.command) {
    process.stdout.write(USAGE);
    return 1;
  }

  const standalone = await runWithoutEngine(args.command, args, cwd);
  if (standalone !== undefined) return standalone;

  // Hooks fire on every edit, so they are latency-critical and manage their own
  // connection: they must never pay for spawning a daemon on the hot path.
  if (args.command === "hook") {
    const { hookCommand } = await import("./commands/hook.js");
    return hookCommand(args, cwd);
  }

  const command = await engineCommand(args.command);
  if (!command) {
    process.stderr.write(`Unknown command: ${args.command}\n\n${USAGE}`);
    return 1;
  }

  const { resolveEngine } = await import("@drumlin/client");
  const resolved = await resolveEngine({
    // Human-only commands never use the daemon, and the daemon refuses them
    // from its side too. Deciding whether a person is running something can
    // only be done by the process holding the terminal, so the decision and
    // the write have to happen there. See commands/accept.ts.
    daemon: HUMAN_ONLY.has(args.command)
      ? false
      : flagBoolean(args, "daemon", true),
  });

  // Awaited before returning. `return command(...)` would look identical and
  // be wrong: in an async function the `finally` runs when the return value is
  // produced, not when the promise it holds settles, so the connection would
  // be torn down with the request still in flight.
  try {
    return await command(resolved.engine, args, cwd);
  } finally {
    resolved.close();
  }
}

type EngineCommand = (
  engine: Awaited<ReturnType<typeof import("@drumlin/client").resolveEngine>>["engine"],
  args: ParsedArgs,
  cwd: string,
) => Promise<number>;

/**
 * Commands that take an engine, as a table rather than a switch.
 *
 * A table because the set of commands then exists as data, which is what lets
 * a test check the usage text against it. The bug that motivated this was an
 * error message offering `drumlin observe`, a command that was never
 * registered: the runtime walk and the diff are built, the browser adapter
 * that would drive them is not. Nothing could have noticed, because the list
 * of real commands was only ever the shape of a `switch`.
 */
const ENGINE_COMMANDS: Record<string, () => Promise<EngineCommand>> = {
  init: async () => (await import("./commands/init.js")).initCommand,
  graph: async () => (await import("./commands/graph.js")).graphCommand,
  check: async () => (await import("./commands/check.js")).checkCommand,
  context: async () => (await import("./commands/context.js")).contextCommand,
  accept: async () => (await import("./commands/accept.js")).acceptCommand,
  revoke: async () => (await import("./commands/accept.js")).revokeCommand,
  propose: async () => (await import("./commands/accept.js")).proposeCommand,
  decline: async () => (await import("./commands/accept.js")).declineCommand,
  claim: async () => (await import("./commands/verify.js")).claimCommand,
  verify: async () => (await import("./commands/verify.js")).verifyCommand,
  activate: async () =>
    (await import("./commands/activate.js")).activateCommand,
  deactivate: async () =>
    (await import("./commands/activate.js")).deactivateCommand,
  export: async () => (await import("./commands/export.js")).exportCommand,
};

/** Everything `drumlin <command>` accepts, engine-backed or not. */
export const COMMANDS: readonly string[] = [
  "help",
  ...Object.keys(ENGINE_COMMANDS),
  "rules",
  "daemon",
  "connect",
  "hook",
].sort();

/** The usage text, exported so a test can hold it against `COMMANDS`. */
export const usage = (): string => USAGE;

async function engineCommand(
  name: string,
): Promise<EngineCommand | undefined> {
  return ENGINE_COMMANDS[name]?.();
}

export async function main(): Promise<void> {
  // Before anything else, and before any import that would fail obscurely.
  const unsupported = unsupportedNode(process.versions.node);
  if (unsupported) {
    process.stderr.write(`${unsupported}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    process.exitCode = await run(process.argv.slice(2), process.cwd());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`drumlin: ${message}\n`);
    process.exitCode = 1;
  }
}
