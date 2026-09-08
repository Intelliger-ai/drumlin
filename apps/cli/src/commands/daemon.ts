import { existsSync, readFileSync } from "node:fs";
import { daemonPaths } from "@drumlin/repo";
import { RemoteEngine, spawnDaemon } from "@drumlin/client";
import { flagString, outputFormat, type ParsedArgs } from "../args.js";

/**
 * `drumlin daemon` — managing the process that normally manages itself.
 *
 * Auto-spawn covers the ordinary case, so this exists for the days it does not:
 * a daemon that will not start, one running a stale build, or one holding more
 * memory than seems reasonable. Every subcommand is about answering "what is it
 * actually doing" without attaching a debugger.
 */

const USAGE = `drumlin daemon <start|stop|status|log>

  start    Start the daemon if it is not already running
  stop     Ask the daemon to exit
  status   Report the daemon and its warm workspaces
  log      Print the daemon's log

Options
  --idle-ms <n>   start: exit after this long without a request
  --lines <n>     log: how many lines to print (default 40)
  --format <fmt>  status: text or json
`;

export async function daemonCommand(args: ParsedArgs): Promise<number> {
  const [subcommand] = args.positional;

  switch (subcommand) {
    case "start":
      return start(args);
    case "stop":
      return stop();
    case "status":
      return status(args);
    case "log":
      return log(args);
    default:
      process.stderr.write(
        subcommand
          ? `Unknown daemon subcommand: ${subcommand}\n\n${USAGE}`
          : USAGE,
      );
      return subcommand ? 1 : 0;
  }
}

async function start(args: ParsedArgs): Promise<number> {
  const paths = daemonPaths();

  const existing = await RemoteEngine.attach({ paths, spawn: false });
  if (existing) {
    const daemon = existing.daemon;
    existing.close();
    process.stdout.write(
      `Already running (pid ${daemon?.pid ?? "?"}) on ${paths.socketFile}\n`,
    );
    return 0;
  }

  const idle = flagString(args, "idle-ms");
  const started = await spawnDaemon({
    paths,
    ...(idle ? { idleMs: Number.parseInt(idle, 10) } : {}),
  });

  if (!started) {
    process.stderr.write(`Daemon did not come up. Check ${paths.logFile}\n`);
    return 1;
  }

  const engine = await RemoteEngine.attach({ paths, spawn: false });
  const pid = engine?.daemon?.pid;
  engine?.close();
  process.stdout.write(
    `Started${pid ? ` (pid ${pid})` : ""} on ${paths.socketFile}\n`,
  );
  return 0;
}

async function stop(): Promise<number> {
  const paths = daemonPaths();
  const engine = await RemoteEngine.attach({ paths, spawn: false });

  if (!engine) {
    process.stdout.write("Not running\n");
    return 0;
  }

  const pid = engine.daemon?.pid;
  try {
    await engine.shutdown();
    process.stdout.write(`Stopped${pid ? ` (pid ${pid})` : ""}\n`);
    return 0;
  } finally {
    engine.close();
  }
}

async function status(args: ParsedArgs): Promise<number> {
  const paths = daemonPaths();
  const format = outputFormat(args);
  const engine = await RemoteEngine.attach({ paths, spawn: false });

  if (!engine) {
    if (format === "json") {
      process.stdout.write(
        `${JSON.stringify({ running: false, socket: paths.socketFile }, null, 2)}\n`,
      );
    } else {
      process.stdout.write(
        `Not running\n  socket  ${paths.socketFile}\n  log     ${paths.logFile}\n`,
      );
    }
    return 0;
  }

  try {
    const report = await engine.daemonStatus();
    const handshake = engine.daemon;

    if (format === "json") {
      process.stdout.write(
        `${JSON.stringify({ running: true, ...report, handshake }, null, 2)}\n`,
      );
      return 0;
    }

    const lines = [
      `Running  pid ${report.pid}  since ${report.startedAt}`,
      `  socket       ${report.socket}`,
      `  protocol     ${handshake?.protocolVersion} · daemon ${handshake?.daemonVersion}`,
      `  connections  ${report.connections}`,
      `  memory       ${report.memoryMb} MB`,
      "",
    ];

    if (report.workspaces.length === 0) {
      lines.push("No warm workspaces. One opens on the first graph request.");
    } else {
      lines.push(`${report.workspaces.length} warm workspace(s)`);
      for (const workspace of report.workspaces) {
        lines.push(`  ${workspace.root}`);
        lines.push(
          `    revision ${workspace.revision} · ${workspace.filesParsed} files · ` +
            `last index ${workspace.lastIndexMs}ms` +
            (workspace.branch ? ` · ${workspace.branch}` : ""),
        );
        if (workspace.pendingFiles > 0) {
          lines.push(
            `    ${workspace.pendingFiles} change(s) not yet folded in`,
          );
        }
        if (workspace.lastError) {
          lines.push(`    last rebuild failed: ${workspace.lastError}`);
        }
      }
    }

    process.stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } finally {
    engine.close();
  }
}

function log(args: ParsedArgs): number {
  const paths = daemonPaths();
  if (!existsSync(paths.logFile)) {
    process.stdout.write(`No log at ${paths.logFile}\n`);
    return 0;
  }

  const count = Number.parseInt(flagString(args, "lines") ?? "40", 10);
  const lines = readFileSync(paths.logFile, "utf8").trimEnd().split("\n");
  process.stdout.write(`${lines.slice(-Math.max(1, count)).join("\n")}\n`);
  return 0;
}
