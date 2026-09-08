import { appendFileSync, mkdirSync } from "node:fs";
import { daemonPaths } from "@drumlin/repo";
import { Daemon, DAEMON_VERSION } from "./server.js";

/**
 * `drumlind` entry point.
 *
 * Normally spawned by a client rather than run by hand, so it logs to a file:
 * its stdio is detached and anything written there goes nowhere. The log is
 * the only way to find out why a daemon that will not start is not starting.
 */
export async function main(argv: readonly string[]): Promise<void> {
  const paths = daemonPaths();

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      `drumlind ${DAEMON_VERSION} — the Drumlin daemon\n\n` +
        `Usage\n  drumlind [--idle-ms <n>] [--foreground]\n\n` +
        `Managed with \`drumlin daemon start|stop|status\`.\n` +
        `Socket: ${paths.socketFile}\n`,
    );
    return;
  }

  const idleMs = numberFlag(argv, "--idle-ms");
  const foreground = argv.includes("--foreground");

  const log = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (foreground) process.stderr.write(line);
    try {
      mkdirSync(paths.dir, { recursive: true });
      appendFileSync(paths.logFile, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      // Losing the log is survivable; failing to start because of it is not.
    }
  };

  const daemon = new Daemon({
    paths,
    ...(idleMs === undefined ? {} : { idleMs }),
    onStop: () => {
      log("stopped");
      // Give the final socket writes a tick to flush.
      setTimeout(() => process.exit(0), 25).unref?.();
    },
  });

  try {
    await daemon.listen();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to start: ${message}`);
    process.stderr.write(`drumlind: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  log(`listening on ${daemon.socketFile} (pid ${process.pid})`);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      log(`received ${signal}`);
      daemon.stop(signal);
    });
  }

  // An uncaught throw in a background rebuild must not leave a half-dead
  // daemon holding the socket, because the next client would connect to it
  // successfully and then hang.
  process.on("uncaughtException", (error) => {
    log(`uncaught: ${error instanceof Error ? error.stack : String(error)}`);
    daemon.stop("uncaught");
  });
}

function numberFlag(argv: readonly string[], name: string): number | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Number.parseInt(argv[index + 1] ?? "", 10);
  return Number.isFinite(value) ? value : undefined;
}
