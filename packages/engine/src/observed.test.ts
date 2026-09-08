import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InProcessEngine } from "./in-process.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../indexer/fixtures/mixed-app",
);

/**
 * What happens when `--observed` cannot be honoured.
 *
 * The runtime half of Drumlin is genuinely half-built: the observation format,
 * the graph-driven walk and the diff all exist and are tested, and the browser
 * adapter that would drive them does not. So `--observed` works, and nothing
 * in the tool can produce the file it wants.
 *
 * That is a fine place to be as long as the error says so. It did not: it
 * offered `drumlin observe`, which answers `Unknown command`. Being sent to a
 * command that does not exist is worse than the missing file you started with,
 * because now you doubt the installation rather than the argument.
 */
describe("asking for an observation that is not there", () => {
  let root: string;
  const engine = new InProcessEngine();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-observed-"));
    cpSync(FIXTURE, root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function failure(observed: string): Promise<Error> {
    return engine
      .request("check.run", { root, observed })
      .then(() => {
        throw new Error("expected check.run to refuse");
      })
      .catch((cause: unknown) => cause as Error);
  }

  it("refuses rather than reporting a clean runtime half", async () => {
    // Every other input to a check has a sensible empty default. An
    // observation does not: treating an unreadable one as "nothing observed"
    // would produce a passing report for a run that never happened.
    const error = await failure(join(root, "nope.json"));

    expect(error.message).toContain("No observation at");
  });

  it("does not offer a command that does not exist", async () => {
    const error = await failure(join(root, "nope.json"));

    expect(error.message).not.toContain("drumlin observe");
  });

  it("says where the file is supposed to come from", async () => {
    // The honest answer is "your own harness, in this shape", so name the
    // shape. It is the only thing the reader can act on.
    const error = await failure(join(root, "nope.json"));

    expect(error.message).toContain("ObservedGraph");
    expect(error.message).toContain("--observed");
  });

  it("distinguishes an unusable observation from a missing one", async () => {
    const path = join(root, "bad.json");
    writeFileSync(path, "{ not json", "utf8");

    const error = await failure(path);

    expect(error.message).toContain("not a usable observation");
    expect(error.message).not.toContain("No observation at");
  });
});
