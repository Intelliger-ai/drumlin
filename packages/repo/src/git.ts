import { execFileSync } from "node:child_process";
import { relative, resolve } from "node:path";

/**
 * Asking Git what changed.
 *
 * Shelling out rather than reading `.git` by hand: working-tree status is the
 * one thing Git's plumbing is genuinely hard to reimplement, and this runs once
 * per `check --changed` rather than per request.
 *
 * Every failure returns an empty list. A repository without Git, a detached
 * HEAD, or a missing revision should make `--changed` report nothing rather
 * than take down the check.
 */

export interface ChangedFilesOptions {
  root: string;
  /**
   * A revision to compare against, e.g. `main` or `HEAD~3`.
   *
   * Omitted means the working tree: staged, unstaged, and untracked files,
   * which is what "what have I touched" means while editing.
   */
  since?: string;
}

export function changedFiles(options: ChangedFilesOptions): string[] {
  const { root, since } = options;

  // Both commands report paths relative to the repository root, not to `-C`.
  // In a monorepo, where `root` is `apps/console` and the repository top is
  // three levels up, resolving against `root` invents paths that do not exist
  // and every one of them looks changed.
  const top = repositoryRoot(root);
  if (!top) return [];

  // Scope with a pathspec so a dirty sibling package, or the docs directory,
  // does not read as "you changed 380 files".
  const within = subtree(top, root);
  const scope = within === "" ? [] : ["--", within];

  const lines = since
    ? git(top, [
        "diff",
        "--name-only",
        "--diff-filter=d",
        `${since}...HEAD`,
        ...scope,
      ])
    : workingTreeChanges(top, scope);

  return [...new Set(lines)]
    .filter((line) => line.length > 0)
    .map((line) => anchor(root, within, line))
    .sort();
}

/**
 * Re-anchor a repository-relative path onto the caller's own root.
 *
 * Deliberately not `resolve(top, line)`. `--show-toplevel` is canonicalised,
 * so on macOS it answers `/private/var/...` for a root the caller knows as
 * `/var/...`; downstream then relativises against the caller's spelling, gets
 * `../../../..`, and discards every changed file as being outside the app.
 * Symlinked checkouts and git worktrees fail the same way. Keeping the base
 * the caller gave us sidesteps the comparison entirely.
 */
function anchor(root: string, within: string, line: string): string {
  if (within === "") return resolve(root, line);
  return resolve(root, relative(within, line));
}

/** The repository top level, or undefined outside a working tree. */
export function repositoryRoot(from: string): string | undefined {
  return git(from, ["rev-parse", "--show-toplevel"])[0] || undefined;
}

/**
 * Where the analysed root sits inside the repository, as Git spells it.
 *
 * Empty means "the whole repository", either because the app is the repository
 * root or because we could not place it. Asking Git rather than subtracting
 * paths ourselves, since `--show-toplevel` and the caller's root can disagree
 * about symlinks while pointing at the same directory.
 */
function subtree(top: string, root: string): string {
  const prefix = git(root, ["rev-parse", "--show-prefix"])[0] ?? "";
  // `--show-prefix` carries a trailing slash and is empty at the top level.
  const trimmed = prefix.replace(/\/+$/, "");
  if (trimmed !== "") return trimmed;

  const subtracted = relative(top, resolve(root));
  return subtracted.startsWith("..") ? "" : subtracted;
}

function workingTreeChanges(top: string, scope: string[]): string[] {
  // Porcelain v1 is stable by contract, which matters for parsing.
  const lines = git(top, [
    "status",
    "--porcelain",
    "--untracked-files=all",
    ...scope,
  ]);

  const files: string[] = [];
  for (const line of lines) {
    if (line.length < 4) continue;
    const path = line.slice(3);
    // A rename reads `R  old -> new`; only the new path still exists.
    const arrow = path.indexOf(" -> ");
    files.push(arrow === -1 ? unquote(path) : unquote(path.slice(arrow + 4)));
  }
  return files;
}

/** Whether the root is inside a Git working tree. */
export function isGitRepository(root: string): boolean {
  return git(root, ["rev-parse", "--is-inside-work-tree"])[0] === "true";
}

export function currentBranch(root: string): string | undefined {
  return git(root, ["rev-parse", "--abbrev-ref", "HEAD"])[0];
}

function git(root: string, args: string[]): string[] {
  try {
    const output = execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A pathological repository must not hang a hook that has to answer fast.
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return output.split("\n").map((line) => line.trimEnd());
  } catch {
    return [];
  }
}

/** Git quotes paths containing unusual bytes. Undo that. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
}
