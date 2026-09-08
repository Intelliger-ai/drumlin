import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unsupportedNode } from "@drumlin/model/runtime";
import { COMMANDS, run, usage } from "./cli.js";
import { versionNear } from "./version.js";

/**
 * The first ninety seconds.
 *
 * Everything here was found by installing Drumlin and using it the way someone
 * would who had just read the README: ask the version, ask for help, run a
 * check, act on what it printed. Each step answered wrongly, and none of it was
 * covered, because the tests were all written from inside — against the engine,
 * which was working fine.
 */
describe("asking what this is", () => {
  function captured(): { out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    return { out, err };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints a version rather than the usage text", async () => {
    const { out } = captured();

    const code = await run(["--version"], process.cwd());

    expect(code).toBe(0);
    expect(out.join("")).toMatch(/^\d+\.\d+\.\d+/);
    expect(out.join("")).not.toContain("Usage");
  });

  it("accepts -v as well", async () => {
    const { out } = captured();

    expect(await run(["-v"], process.cwd())).toBe(0);
    expect(out.join("")).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 0 for --help, because asking is not an error", async () => {
    // This exited 1, which is enough to fail a CI step whose only job is
    // checking that the thing installed.
    const { out } = captured();

    expect(await run(["--help"], process.cwd())).toBe(0);
    expect(out.join("")).toContain("Usage");
  });

  it("exits 0 for -h", async () => {
    captured();
    expect(await run(["-h"], process.cwd())).toBe(0);
  });

  it("treats `help` as a command, not an unknown one", async () => {
    // `drumlin help` answered `Unknown command: help`, then printed the help.
    const { out, err } = captured();

    expect(await run(["help"], process.cwd())).toBe(0);
    expect(out.join("")).toContain("Usage");
    expect(err.join("")).not.toContain("Unknown command");
  });

  it("lists `help` among the commands it accepts", async () => {
    const { out } = captured();
    await run(["help"], process.cwd());

    expect(out.join("")).toMatch(/^\s+help\s+/m);
    expect(out.join("")).toContain("--version");
  });

  it("still fails when nothing was asked for", async () => {
    // The one usage-printing case that is not a request.
    captured();
    expect(await run([], process.cwd())).toBe(1);
  });

  it("still rejects a command it does not have", async () => {
    const { err } = captured();

    expect(await run(["frobnicate"], process.cwd())).toBe(1);
    expect(err.join("")).toContain("Unknown command: frobnicate");
  });
});

/**
 * The documented surface and the real one, held against each other.
 *
 * Prompted by an error message that offered `drumlin observe`, which was never
 * a command: the runtime walk and the diff are built, the browser adapter that
 * would drive them is not. It shipped because the list of real commands only
 * existed as the shape of a `switch`, so nothing could compare the two.
 */
describe("what the usage text promises", () => {
  /** The command column of the `Commands` block. */
  function documented(): string[] {
    const block = /\nCommands\n([\s\S]*?)\n\n/.exec(usage())?.[1] ?? "";
    return block
      .split("\n")
      .map((line) => /^\s{2}(\S+)/.exec(line)?.[1])
      .filter((name): name is string => Boolean(name));
  }

  it("lists nothing that cannot be run", () => {
    expect(documented().filter((name) => !COMMANDS.includes(name))).toEqual([]);
  });

  it("documents everything that can be run", () => {
    const missing = COMMANDS.filter((name) => !documented().includes(name));
    expect(missing).toEqual([]);
  });

  it("does not mention a command it does not have", () => {
    // `observe` is the specific one. Kept as a named case because the runtime
    // half is half-built, which makes it the likeliest to be referred to again
    // before it exists.
    expect(usage()).not.toContain("drumlin observe");
    expect(COMMANDS).not.toContain("observe");
  });
});

describe("finding our own version", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-version-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function manifest(at: string, contents: unknown): void {
    mkdirSync(join(root, at), { recursive: true });
    writeFileSync(
      join(root, at, "package.json"),
      JSON.stringify(contents),
      "utf8",
    );
  }

  it("reads the version from the manifest above it", () => {
    manifest(".", { name: "drumlin", version: "1.2.3" });
    mkdirSync(join(root, "dist"), { recursive: true });

    expect(versionNear(join(root, "dist"))).toBe("1.2.3");
  });

  it("walks past manifests that are not ours", () => {
    // The case that makes a naive nearest-manifest read confidently wrong:
    // installed under someone else's tree, or run by a test runner.
    manifest(".", { name: "drumlin", version: "1.2.3" });
    manifest("node_modules/vitest", { name: "vitest", version: "9.9.9" });

    expect(versionNear(join(root, "node_modules/vitest"))).toBe("1.2.3");
  });

  it("accepts a workspace package as ours", () => {
    manifest("apps/cli", { name: "@drumlin/cli", version: "0.4.0" });

    expect(versionNear(join(root, "apps/cli"))).toBe("0.4.0");
  });

  it("reports nothing rather than guessing", () => {
    manifest(".", { name: "something-else", version: "9.9.9" });

    expect(versionNear(root)).toBeUndefined();
  });

  it("survives a manifest that is not valid JSON", () => {
    mkdirSync(join(root, "broken"), { recursive: true });
    writeFileSync(join(root, "broken/package.json"), "{ not json", "utf8");

    expect(versionNear(join(root, "broken"))).toBeUndefined();
  });
});

describe("refusing an unsupported Node", () => {
  it("names the version it found and the one it needs", () => {
    // The failure this replaces is `Cannot find module 'node:sqlite'`, thrown
    // from a cache layer, with no mention of Node at all.
    const message = unsupportedNode("v20.11.0");

    expect(message).toContain("Node 22 or newer");
    expect(message).toContain("v20.11.0");
    expect(message).toContain("node:sqlite");
  });

  it("allows the versions it supports", () => {
    expect(unsupportedNode("v22.0.0")).toBeUndefined();
    expect(unsupportedNode("v24.3.1")).toBeUndefined();
    expect(unsupportedNode("v30.0.0")).toBeUndefined();
  });

  it("allows the version actually running these tests", () => {
    expect(unsupportedNode(process.versions.node)).toBeUndefined();
  });

  it("stays out of the way when it cannot read the version", () => {
    // An unreleased build or another runtime is better served by the real
    // failure than by a guess from a string this did not parse.
    expect(unsupportedNode("wat")).toBeUndefined();
    expect(unsupportedNode("")).toBeUndefined();
  });
});
