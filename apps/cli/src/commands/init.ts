import { relative } from "node:path";
import { initRepo, repoPaths } from "@drumlin/repo";
import { flagString, type ParsedArgs } from "../args.js";
import { dim } from "../format/outline.js";
import type { Engine } from "@drumlin/engine";

/**
 * `drumlin init` — create the `.drumlin/` contract.
 *
 * Deliberately minimal: directories, a config stub, and an ignore rule for the
 * derived cache. Nothing is inferred here — `drumlin context` does that, and
 * only when asked.
 */
export async function initCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const root = flagString(args, "app") ?? flagString(args, "root") ?? cwd;
  const { app } = await engine.request("workspace.open", { root });

  const { created } = initRepo(app.root);
  const paths = repoPaths(app.root);

  const lines: string[] = [];
  lines.push(
    `Drumlin initialised for ${relative(cwd, app.root) || "."} (${app.router} router)`,
  );

  if (created.length === 0) {
    lines.push(dim("Already set up; nothing changed."));
  } else {
    for (const path of created)
      lines.push(`  created ${relative(app.root, path)}`);
  }

  lines.push("");
  lines.push(
    dim(
      `Committed: ${relative(app.root, paths.contextDir)}, ${relative(app.root, paths.issuesDir)}`,
    ),
  );
  lines.push(
    dim(
      `Derived and disposable: ${relative(app.root, paths.cacheDir)} — safe to delete at any time`,
    ),
  );
  lines.push("");
  lines.push(
    "Next: `drumlin graph` to check what was understood, then `drumlin check`.",
  );
  // Init deliberately does not activate. Setting up the contract and agreeing
  // to be interrupted while you work are different decisions, and conflating
  // them is how a tool ends up running somewhere nobody asked it to.
  lines.push(
    dim(
      "Findings stay on demand until you run `drumlin activate` in this project.",
    ),
  );

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
