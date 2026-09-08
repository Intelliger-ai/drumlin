import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { daemonCommand } from "./spawn.js";

/**
 * Finding the daemon.
 *
 * This had no tests, and the cost of that was a regression nobody could see.
 * Resolution was a single `import.meta.resolve("@drumlin/daemon/bin")`, correct
 * while the CLI ran as TypeScript from the workspace and wrong once it was
 * bundled: the specifier then resolves against `apps/cli/node_modules`, which
 * has no `@drumlin/daemon`, because the CLI does not depend on the daemon — the
 * client does.
 *
 * Nothing threw. Resolution returned nothing, the caller fell back to
 * `drumlind` on PATH, nothing was on PATH, and a failed spawn is treated as
 * "run in-process instead". The daemon silently stopped being used and every
 * command paid for a cold index.
 *
 * So these tests assert the resolved path *exists*. A test that only checked
 * for a non-empty return would have passed throughout.
 *
 * They also pin why the layout search has to come first rather than serve as a
 * fallback: `import.meta.resolve` is not a function under this test runner's
 * transform, so resolution by package name is unavailable here and cannot be
 * the mechanism anything depends on.
 */
describe("locating the daemon", () => {
  const argv = process.argv[1];
  const override = process.env["DRUMLIN_DAEMON_COMMAND"];
  let root: string;

  beforeEach(() => {
    // Resolution reports realpaths, and on macOS the temp directory is reached
    // through a symlink, so the fixture root has to be resolved to compare.
    root = realpathSync(mkdtempSync(join(tmpdir(), "drumlin-spawn-")));
    delete process.env["DRUMLIN_DAEMON_COMMAND"];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    // `argv[1]` is how resolution knows which layout it is in, so every test
    // moves it. Leaving it moved would break whatever runs next.
    if (argv === undefined) delete process.argv[1];
    else process.argv[1] = argv;
    if (override === undefined) delete process.env["DRUMLIN_DAEMON_COMMAND"];
    else process.env["DRUMLIN_DAEMON_COMMAND"] = override;
  });

  /** Lay out an install and pretend we were started from its CLI. */
  function install(cli: string, daemon?: string): void {
    const cliPath = join(root, cli);
    mkdirSync(join(cliPath, ".."), { recursive: true });
    writeFileSync(cliPath, "#!/usr/bin/env node\n", "utf8");

    if (daemon) {
      const daemonPath = join(root, daemon);
      mkdirSync(join(daemonPath, ".."), { recursive: true });
      writeFileSync(daemonPath, "#!/usr/bin/env node\n", "utf8");
    }

    process.argv[1] = cliPath;
  }

  function resolved(): { command: string[]; path?: string } {
    const command = daemonCommand();
    return { command, ...(command[1] ? { path: command[1] } : {}) };
  }

  it("finds the daemon beside the CLI, as a published package ships it", () => {
    install("dist/drumlin.mjs", "dist/drumlind.mjs");

    const { command, path } = resolved();

    expect(command[0]).toBe(process.execPath);
    expect(path).toBe(join(root, "dist/drumlind.mjs"));
    expect(existsSync(path!)).toBe(true);
  });

  it("does not go hunting through sibling directories", () => {
    // The search is deliberately narrow, and this is the layout it gave up:
    // one dist per app. The build stopped producing it — all three
    // executables are assembled into one directory now — and a candidate for
    // a layout nothing produces is exactly the plausible-looking path that
    // hid the original bug. If the build is ever split again, this is the
    // test that should be changed rather than worked around.
    install("apps/cli/dist/drumlin.mjs", "apps/daemon/dist/drumlind.mjs");

    expect(resolved().path).toBeUndefined();
  });

  it("finds the source daemon when running through tsx", () => {
    install("apps/cli/bin/drumlin.mjs", "apps/daemon/bin/drumlind.mjs");

    const { path } = resolved();

    expect(path).toBe(join(root, "apps/daemon/bin/drumlind.mjs"));
    expect(existsSync(path!)).toBe(true);
  });

  it("prefers the nearest layout when more than one could match", () => {
    // A built monorepo that has also been packaged. The adjacent copy is the
    // one that belongs to this executable.
    install("apps/cli/dist/drumlin.mjs", "apps/cli/dist/drumlind.mjs");
    const alternative = join(root, "apps/daemon/dist/drumlind.mjs");
    mkdirSync(join(alternative, ".."), { recursive: true });
    writeFileSync(alternative, "#!/usr/bin/env node\n", "utf8");

    expect(resolved().path).toBe(join(root, "apps/cli/dist/drumlind.mjs"));
  });

  it("never reports a path it has not confirmed exists", () => {
    // The regression, stated as a property. A layout that looks right but has
    // no daemon in it must not produce a path.
    install("apps/cli/dist/drumlin.mjs");

    const { command } = resolved();
    const path = command[1];

    if (path !== undefined) {
      // Resolution fell through to the installed package, which is legitimate
      // here — but it still has to be a real file.
      expect(existsSync(path)).toBe(true);
    }
  });

  it("lets an explicit command win over any layout", () => {
    install("dist/drumlin.mjs", "dist/drumlind.mjs");
    process.env["DRUMLIN_DAEMON_COMMAND"] = "/opt/custom/drumlind --foreground";

    expect(daemonCommand()).toEqual(["/opt/custom/drumlind", "--foreground"]);
  });

  // The end-to-end guard: not a fixture, this repository. Run from either of
  // the CLI's real entry points, resolution has to land on a daemon that is
  // actually on disk, and must not fall through to `drumlind` on PATH — which
  // is the failure the bundle shipped, and which no test could see.
  describe("in this repository", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

    function from(cli: string): string[] {
      process.argv[1] = join(repo, cli);
      return daemonCommand();
    }

    it("finds the daemon when the CLI runs from source", () => {
      const command = from("apps/cli/bin/drumlin.mjs");

      expect(command).not.toEqual(["drumlind"]);
      expect(command[0]).toBe(process.execPath);
      expect(existsSync(command[1]!)).toBe(true);
    });

    it("finds the daemon in the assembled package", () => {
      // Skipped rather than failed when there is no build: `pnpm test` has to
      // work on a fresh clone. CI runs `pnpm build` too, which is where this
      // one earns its place.
      const built = "packages/drumlin/dist/drumlin.mjs";
      if (!existsSync(join(repo, built))) return;

      const command = from(built);

      expect(command).not.toEqual(["drumlind"]);
      expect(command[1]).toBe(join(repo, "packages/drumlin/dist/drumlind.mjs"));
      expect(existsSync(command[1]!)).toBe(true);
    });
  });
});
