import { relative } from "node:path";
import type { Engine } from "@drumlin/engine";
import {
  flagBoolean,
  flagString,
  outputFormat,
  type ParsedArgs,
} from "../args.js";
import { dim, renderGraphSummary, renderOutline } from "../format/outline.js";

/**
 * `drumlin graph` — dump the IR.
 *
 * The checkpoint command. Its whole reason for existing is that a wrong graph
 * makes every rule wrong with no way to tell which, so the graph gets read by a
 * human before a single rule runs.
 */
export async function graphCommand(
  engine: Engine,
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const format = outputFormat(args);
  const root = flagString(args, "app") ?? flagString(args, "root") ?? cwd;

  const result = await engine.request("graph.get", {
    root,
    cache: flagBoolean(args, "cache", true),
  });

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(result.graph, null, 2)}\n`);
    return 0;
  }

  const limitFlag = flagString(args, "limit");
  const limit = limitFlag ? Number.parseInt(limitFlag, 10) : 40;

  const lines: string[] = [];
  lines.push(
    `Drumlin graph — ${relative(cwd, result.graph.workspace?.root ?? root) || "."}`,
  );
  lines.push(
    dim(
      `${renderGraphSummary(result.graph)}${
        result.cached
          ? "  (from cache)"
          : `  (${result.stats.filesParsed} files in ${result.stats.durationMs}ms)`
      }`,
    ),
  );

  lines.push(
    renderOutline(result.graph, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : 40,
    }),
  );

  if (result.brokenLinks.length > 0) {
    lines.push("");
    lines.push(`Hrefs matching no known route (${result.brokenLinks.length}):`);
    for (const link of result.brokenLinks.slice(0, 20)) {
      lines.push(`  ${link.href}  ${dim(`${link.file}:${link.line}`)}`);
    }
    if (result.brokenLinks.length > 20) {
      lines.push(dim(`  … ${result.brokenLinks.length - 20} more`));
    }
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
