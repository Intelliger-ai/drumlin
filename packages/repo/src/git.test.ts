import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { changedFiles, isGitRepository, repositoryRoot } from "./git.js";

/**
 * Against a real repository, because the bug this file exists to prevent was
 * a wrong assumption about what Git prints, not a wrong branch in our code:
 * `status --porcelain` reports paths relative to the repository root, and
 * resolving those against a monorepo sub-package invented 380 changed files
 * that did not exist.
 */

let repo: string;
let app: string;

function run(args: string[], cwd = repo): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function write(path: string, contents: string): void {
  const full = join(repo, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "drumlin-git-"));
  app = join(repo, "apps", "console");

  run(["init", "--initial-branch=main"]);
  run(["config", "user.email", "test@drumlin.local"]);
  run(["config", "user.name", "Drumlin Test"]);

  write("apps/console/src/page.tsx", "export default function Page() {}\n");
  write("apps/website/src/page.tsx", "export default function Site() {}\n");
  write("docs/readme.md", "# docs\n");
  run(["add", "."]);
  run(["commit", "-m", "initial"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("repositoryRoot", () => {
  it("finds the top level from a nested directory", () => {
    // realpath, because macOS hands out /var symlinks for temp directories.
    expect(repositoryRoot(app)).toBe(
      execFileSync("git", ["-C", app, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim(),
    );
  });

  it("returns undefined outside a working tree", () => {
    expect(repositoryRoot(tmpdir())).toBeUndefined();
  });
});

describe("changedFiles", () => {
  it("returns nothing on a clean tree", () => {
    expect(changedFiles({ root: app })).toEqual([]);
  });

  it("returns absolute paths that actually exist", () => {
    write("apps/console/src/page.tsx", "export default function Page() { }\n");

    const changed = changedFiles({ root: app });

    expect(changed).toHaveLength(1);
    // The regression: a path resolved against the wrong base is still a
    // string, and every downstream consumer treats it as real.
    expect(relative(app, changed[0]!)).toBe(join("src", "page.tsx"));
  });

  /**
   * The actual failure. A dirty sibling package used to be reported as a
   * change inside the app under analysis.
   */
  it("ignores changes in a sibling package", () => {
    write("apps/website/src/page.tsx", "export default function Site() { }\n");

    const changed = changedFiles({ root: app });

    expect(changed.some((file) => file.includes("website"))).toBe(false);
  });

  it("sees untracked files", () => {
    write("apps/console/src/new.tsx", "export const New = () => null;\n");

    expect(
      changedFiles({ root: app }).some((file) => file.endsWith("new.tsx")),
    ).toBe(true);
  });

  it("compares against a revision when given one", () => {
    run(["stash", "--include-untracked"]);
    run(["checkout", "-b", "feature"]);
    write("apps/console/src/added.tsx", "export const Added = () => null;\n");
    run(["add", "."]);
    run(["commit", "-m", "add screen"]);

    const changed = changedFiles({ root: app, since: "main" });

    expect(changed.map((file) => relative(app, file))).toEqual([
      join("src", "added.tsx"),
    ]);
  });

  it("returns nothing rather than throwing on an unknown revision", () => {
    expect(changedFiles({ root: app, since: "no-such-branch" })).toEqual([]);
  });

  it("returns nothing outside a repository", () => {
    expect(changedFiles({ root: tmpdir() })).toEqual([]);
  });
});

describe("isGitRepository", () => {
  it("distinguishes a working tree from a bare directory", () => {
    expect(isGitRepository(app)).toBe(true);
    expect(isGitRepository(tmpdir())).toBe(false);
  });
});
