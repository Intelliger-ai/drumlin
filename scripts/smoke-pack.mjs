#!/usr/bin/env node
/**
 * Install the package the way a stranger would, and check it works.
 *
 * `pnpm test` runs against the workspace, where every `@drumlin/*` resolves
 * through a symlink that a published install does not have. That gap has
 * already cost three bugs — the plugin's CLI path, the agent skill, and worst,
 * the daemon, which resolved fine under the workspace and returned nothing
 * from the bundle. Auto-spawn failed, the client fell back in-process by
 * design, and no test could see it because no test installed anything.
 *
 * So this packs a tarball, installs it into an empty directory with a global
 * prefix of its own, and drives the result. It touches nothing outside its
 * temporary directory: `--prefix` keeps the "global" install local, which is
 * the point — a smoke test that writes to the machine's npm root is one nobody
 * runs twice.
 *
 * Run after `pnpm build`. Exits non-zero on the first failed check.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages", "drumlin");
const fixture = join(root, "packages", "indexer", "fixtures", "mixed-app");

if (!existsSync(join(pkg, "dist", "drumlin.mjs"))) {
  fail("no build to pack — run `pnpm build` first");
}

const work = mkdtempSync(join(tmpdir(), "drumlin-smoke-"));
const prefix = join(work, "global");
const app = join(work, "app");
mkdirSync(prefix, { recursive: true });

let failures = 0;

try {
  const tarball = pack();
  const bin = install(tarball);

  check("reports its version", () => {
    const printed = run(bin.drumlin, ["--version"]).trim();
    if (!/^\d+\.\d+\.\d+/.test(printed)) {
      throw new Error(`expected a version, got ${JSON.stringify(printed)}`);
    }
  });

  check("exits 0 for --help", () => {
    run(bin.drumlin, ["--help"]);
  });

  check("all three executables are on the prefix", () => {
    for (const [name, path] of Object.entries(bin)) {
      if (!existsSync(path)) throw new Error(`${name} was not installed`);
    }
  });

  check("analyses an app it has never seen", () => {
    execFileSync("cp", ["-R", fixture, app]);
    const report = run(bin.drumlin, ["check", "--no-daemon"], app);
    if (!/UX-|flow\.orphan/.test(report)) {
      throw new Error(`no findings in:\n${report}`);
    }
  });

  /**
   * The one that matters. This is the exact configuration the daemon
   * regression shipped in, and the failure was silent: a failed spawn falls
   * back in-process, so the only evidence is that nothing is warm.
   */
  check("auto-spawns its own daemon", () => {
    run(bin.drumlin, ["daemon", "stop"], app, { allowFailure: true });
    run(bin.drumlin, ["check"], app);

    const status = run(bin.drumlin, ["daemon", "status"], app);
    if (!/warm workspace/.test(status)) {
      throw new Error(
        `nothing went warm, so the daemon was never used:\n${status}`,
      );
    }
  });

  check("keeps issue ids once initialised", () => {
    run(bin.drumlin, ["init"], app);
    const first = ids(run(bin.drumlin, ["check", "--format", "json"], app));
    const second = ids(run(bin.drumlin, ["check", "--format", "json"], app));

    if (first.length === 0) throw new Error("init produced no issue ids");
    if (String(first) !== String(second)) {
      throw new Error(`ids moved between runs: ${first} then ${second}`);
    }
  });

  check("the MCP server answers an initialize", () => {
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      },
    };

    // A stdio server holds its pipes open and waits for the next request, so
    // there is no clean exit to wait for: closing stdin is not a shutdown
    // signal, and reading to EOF never returns. Being killed is the expected
    // ending here, and the reply is on the error rather than the return.
    const reply = speak(bin["drumlin-mcp"], `${JSON.stringify(request)}\n`);

    if (!reply.includes('"serverInfo"')) {
      throw new Error(`no initialize result in: ${reply.slice(0, 300)}`);
    }
  });
} finally {
  run(join(prefix, "bin", "drumlin"), ["daemon", "stop"], work, {
    allowFailure: true,
  });
  rmSync(work, { recursive: true, force: true });
}

if (failures > 0) fail(`${failures} smoke check(s) failed`);
process.stdout.write("\nsmoke ok — the packed install works\n");

function pack() {
  const name = execFileSync("npm", ["pack", "--silent"], {
    cwd: pkg,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();

  const tarball = join(pkg, name);
  process.stdout.write(`packed ${name}\n`);
  return tarball;
}

function install(tarball) {
  execFileSync("npm", ["install", "--global", "--prefix", prefix, tarball], {
    stdio: "inherit",
  });
  rmSync(tarball, { force: true });

  return {
    drumlin: join(prefix, "bin", "drumlin"),
    drumlind: join(prefix, "bin", "drumlind"),
    "drumlin-mcp": join(prefix, "bin", "drumlin-mcp"),
  };
}

function check(what, body) {
  try {
    body();
    process.stdout.write(`  ok    ${what}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`  FAIL  ${what}\n`);
    process.stdout.write(`        ${messageOf(error)}\n`);
  }
}

function run(command, args, cwd = work, { allowFailure = false } = {}) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1 << 24,
    });
  } catch (error) {
    if (allowFailure) return error.stdout ?? "";
    throw new Error(
      `${command} ${args.join(" ")} failed: ${messageOf(error)}\n` +
        `${error.stdout ?? ""}${error.stderr ?? ""}`,
    );
  }
}

/**
 * The `UX-` ids a check assigned.
 *
 * `issueId` sits on each finding rather than in an `issues` array: a finding
 * is what the rules produced, and the id is what persistence gave it. Before
 * `init` there is nowhere to keep them and the field is absent, which is
 * exactly the distinction the next check is testing.
 */
/** One request to a server that will not hang up, and whatever it said back. */
function speak(command, request) {
  try {
    return execFileSync(command, [], {
      cwd: app,
      input: request,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
      maxBuffer: 1 << 22,
    });
  } catch (error) {
    if (error.stdout) return error.stdout;
    throw new Error(`no reply: ${messageOf(error)}${error.stderr ?? ""}`);
  }
}

function ids(json) {
  return (JSON.parse(json).findings ?? [])
    .map((finding) => finding.issueId)
    .filter(Boolean)
    .sort();
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(why) {
  process.stderr.write(`smoke: ${why}\n`);
  process.exit(1);
}
