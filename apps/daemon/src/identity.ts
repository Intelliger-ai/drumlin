import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Workspace identity.
 *
 * One daemon serves every repository the developer has open, so two clients
 * naming the same project must land on the same warm graph. Path strings alone
 * do not do that: `/tmp/app`, `/tmp/app/`, and a symlink into it are the same
 * workspace, while two Git worktrees of one repository are not.
 *
 * The key is therefore the canonical path plus the Git common directory, per
 * Process Ownership in Context/02. Reading `.git` by hand rather than shelling
 * out to `git` matters because this runs on every request.
 */

export interface WorkspaceIdentity {
  /** Stable hash, used as the registry key. */
  key: string;
  /** Symlinks resolved, trailing slash removed. */
  root: string;
  /** The shared `.git` directory, when the root is inside a repository. */
  gitCommonDir?: string;
  /** Branch at the time of asking. Reported, never part of the key. */
  branch?: string;
}

export function workspaceIdentity(root: string): WorkspaceIdentity {
  const canonical = canonicalPath(root);
  const gitDir = findGitDir(canonical);
  const commonDir = gitDir ? gitCommonDir(gitDir) : undefined;

  const hash = createHash("sha256");
  hash.update(canonical);
  hash.update("\0");
  hash.update(commonDir ?? "");

  const identity: WorkspaceIdentity = {
    key: hash.digest("hex").slice(0, 32),
    root: canonical,
  };
  if (commonDir) identity.gitCommonDir = commonDir;
  if (gitDir) {
    const branch = readBranch(gitDir);
    if (branch) identity.branch = branch;
  }
  return identity;
}

export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    // A path that does not exist yet is still a usable key; the caller will
    // fail later with a better message than this function could give.
    return absolute;
  }
}

/** The nearest `.git`, walking up. Returns the resolved directory. */
function findGitDir(from: string): string | undefined {
  let current = from;

  for (;;) {
    const candidate = join(current, ".git");
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        return undefined;
      }
      // A worktree or submodule has a `.git` file pointing elsewhere.
      const pointer = readGitFilePointer(candidate);
      if (pointer) return pointer;
      return undefined;
    }

    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function readGitFilePointer(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    const match = /^gitdir:\s*(.+)$/.exec(text);
    if (!match?.[1]) return undefined;
    const target = match[1].trim();
    return canonicalPath(
      target.startsWith("/") ? target : join(dirname(file), target),
    );
  } catch {
    return undefined;
  }
}

/**
 * The directory shared by every worktree of a repository.
 *
 * A linked worktree's git dir contains a `commondir` file pointing at the main
 * one. Using it means two worktrees of the same repo share a Git identity but
 * still get distinct keys, because their canonical paths differ.
 */
function gitCommonDir(gitDir: string): string {
  const pointer = join(gitDir, "commondir");
  if (!existsSync(pointer)) return gitDir;
  try {
    const target = readFileSync(pointer, "utf8").trim();
    if (!target) return gitDir;
    return canonicalPath(
      target.startsWith("/") ? target : join(gitDir, target),
    );
  } catch {
    return gitDir;
  }
}

function readBranch(gitDir: string): string | undefined {
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const match = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return match?.[1] ?? head.slice(0, 12);
  } catch {
    return undefined;
  }
}
