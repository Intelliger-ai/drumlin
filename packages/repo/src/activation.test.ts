import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readActivation, setActivation } from "./activation.js";
import { initRepo } from "./context.js";
import { repoPaths } from "./paths.js";

/**
 * Per-project consent.
 *
 * The Cursor plugin installs once per machine and its hooks fire in every
 * workspace, so before this existed, wanting Drumlin on one repository meant
 * getting it on every repository the developer opened. Every default here
 * leans the same way: anything other than an explicit `true` is a no.
 */
describe("activation", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-activate-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("is inactive in a directory Drumlin has never seen", () => {
    expect(readActivation(root)).toEqual({
      initialised: false,
      active: false,
    });
  });

  it("stays inactive after init", () => {
    initRepo(root);

    // Setting up the contract and agreeing to be interrupted while you work
    // are different decisions.
    expect(readActivation(root)).toMatchObject({
      initialised: true,
      active: false,
    });
  });

  it("activates, and records when", () => {
    initRepo(root);
    const result = setActivation(root, true);

    expect(result.active).toBe(true);
    expect(result.activatedAt).toBeDefined();
    expect(readActivation(root).active).toBe(true);
  });

  it("deactivates, and drops the timestamp with it", () => {
    initRepo(root);
    setActivation(root, true);
    setActivation(root, false);

    const activation = readActivation(root);
    expect(activation.active).toBe(false);
    expect(activation.activatedAt).toBeUndefined();
  });

  it("keeps the rest of the config, comments included", () => {
    initRepo(root);
    const file = repoPaths(root).configFile;
    const before = readFileSync(file, "utf8");
    expect(before).toContain("# Whether Drumlin may act on its own");

    setActivation(root, true);
    const after = readFileSync(file, "utf8");

    // This file is committed and hand-edited. Reformatting somebody's comments
    // out of existence to set one boolean is not an acceptable trade.
    expect(after).toContain("# Whether Drumlin may act on its own");
    expect(after).toContain("# Routes reached only by bookmark");
    expect(after).toContain("schemaVersion: 1");
  });

  it("preserves a comment the developer added themselves", () => {
    initRepo(root);
    const file = repoPaths(root).configFile;
    writeFileSync(
      file,
      `${readFileSync(file, "utf8")}\n# ours: see RFC-114 before touching\n`,
      "utf8",
    );

    setActivation(root, true);

    expect(readFileSync(file, "utf8")).toContain("RFC-114");
  });

  it("refuses to activate where there is nothing to activate", () => {
    expect(() => setActivation(root, true)).toThrow(/drumlin init/);
  });

  describe("anything ambiguous means no", () => {
    it("treats a truthy string as inactive", () => {
      initRepo(root);
      writeFileSync(
        repoPaths(root).configFile,
        "loop:\n  enabled: 'true'\n",
        "utf8",
      );

      // Strictly `true`. The cost of guessing wrong is a tool reading a
      // stranger's repository.
      expect(readActivation(root).active).toBe(false);
    });

    it("treats an unparseable config as inactive", () => {
      initRepo(root);
      writeFileSync(repoPaths(root).configFile, "loop: [oh no\n  :", "utf8");

      expect(readActivation(root)).toMatchObject({
        initialised: true,
        active: false,
      });
    });

    it("treats a missing config as inactive", () => {
      initRepo(root);
      rmSync(repoPaths(root).configFile);

      expect(readActivation(root)).toMatchObject({
        initialised: true,
        active: false,
      });
    });
  });
});
