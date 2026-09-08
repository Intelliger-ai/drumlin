import { relative } from "node:path";
import { findRepoRoot, readActivation, setActivation } from "@drumlin/repo";
import { flagString, outputFormat, type ParsedArgs } from "../args.js";
import { dim } from "../format/outline.js";
import type { Engine } from "@drumlin/engine";

/**
 * `drumlin activate` / `drumlin deactivate` — consent, per project.
 *
 * The editor plugin installs once per machine and its hooks fire in every
 * workspace. That makes "I want Drumlin on this project" and "I want Drumlin
 * reading every repository I open" the same decision, which is the wrong
 * default for a tool that reads source and spends agent turns. So the
 * automatic surfaces stay silent until someone runs this.
 *
 * A command rather than a prompt because consent should be recorded where the
 * team can see it: this writes `loop.enabled` into the committed config, so
 * activating is a reviewable diff rather than local state on one laptop.
 */
export async function activateCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  return flip(engine, args, cwd, true);
}

export async function deactivateCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  return flip(engine, args, cwd, false);
}

async function flip(
  _engine: Engine,
  args: ParsedArgs,
  cwd: string,
  active: boolean,
): Promise<number> {
  const from = flagString(args, "app") ?? flagString(args, "root") ?? cwd;

  // Deliberately not `workspace.open`. This command writes one flag into
  // `config.yaml` and needs no graph, no index, and no framework — but routing
  // it through app resolution made it refuse to run anywhere Drumlin could not
  // find a Next.js app, including the root of a monorepo, which is the obvious
  // place to type it.
  const root = findRepoRoot(from);

  if (!root) {
    process.stderr.write(
      `Drumlin is not set up in ${relative(cwd, from) || "."} ` +
        `or any directory above it.\n` +
        `Run \`drumlin init\` first, so issue ids and decisions have somewhere to live.\n`,
    );
    return 1;
  }

  const before = readActivation(root);
  const after = setActivation(root, active);

  if (outputFormat(args) === "json") {
    process.stdout.write(`${JSON.stringify(after, null, 2)}\n`);
    return 0;
  }

  const where = relative(cwd, root) || ".";

  if (!active) {
    process.stdout.write(
      `Drumlin deactivated for ${where}\n` +
        dim(
          "  The editor hooks and the agent's tools go quiet here. " +
            "`drumlin check` still works.\n",
        ),
    );
    return 0;
  }

  if (before.active) {
    process.stdout.write(
      `Drumlin was already active for ${where}\n` +
        dim(`  since ${before.activatedAt ?? "an earlier run"}\n`),
    );
    return 0;
  }

  process.stdout.write(
    `Drumlin activated for ${where}\n` +
      "\n" +
      "  Findings now reach you while you code:\n" +
      dim("    on every agent edit, the graph re-indexes in the background\n") +
      dim(
        "    at the end of a turn, new high-severity problems go back to the agent\n",
      ) +
      dim("    the agent can pull its own issue packet over MCP\n") +
      "\n" +
      dim("  Committed to .drumlin/config.yaml, so your team gets it too.\n") +
      dim("  Turn it off with `drumlin deactivate`.\n"),
  );
  return 0;
}
