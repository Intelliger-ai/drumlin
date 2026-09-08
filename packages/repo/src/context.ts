import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import {
  PermissionsDocumentSchema,
  emptyPermissions,
  type PermissionsDocument,
} from "@drumlin/model";
import { repoPaths } from "./paths.js";

/**
 * Committed context: what the product is meant to be.
 *
 * YAML rather than JSON because a human is expected to edit it and review it in
 * a diff. Comments survive nothing here, so the file carries a header explaining
 * what it is instead.
 */

const HEADER = `# Drumlin permissions context
#
# Drumlin proposes; you confirm. Nothing in this file is inferred silently —
# entries with provenance.source: human are facts you have confirmed, and only
# confirmed facts are used to reason about access control.
#
# Regenerate proposals with: drumlin context
`;

export function readPermissions(root: string): PermissionsDocument {
  const paths = repoPaths(root);
  if (!existsSync(paths.permissionsFile)) return emptyPermissions();
  try {
    const parsed = parse(readFileSync(paths.permissionsFile, "utf8"));
    return PermissionsDocumentSchema.parse(parsed);
  } catch {
    // An unparseable context file must not stop a check run; treating it as
    // absent means rules that need confirmation simply stay quiet.
    return emptyPermissions();
  }
}

export function writePermissions(
  root: string,
  document: PermissionsDocument,
): string {
  const paths = repoPaths(root);
  mkdirSync(paths.contextDir, { recursive: true });
  const body = stringify(PermissionsDocumentSchema.parse(document), {
    lineWidth: 80,
  });
  writeFileSync(paths.permissionsFile, `${HEADER}\n${body}`, "utf8");
  return paths.permissionsFile;
}

export interface DrumlinConfig {
  /**
   * Routes a user can arrive at without navigating.
   *
   * Declared entry points override convention, which is the escape hatch for
   * orphan detection: a screen reached only by a bookmark or an emailed link is
   * not a bug, and only the person who built it knows that.
   */
  entryPoints: string[];
  /** Rule IDs to skip. */
  disabledRules: string[];
}

const DEFAULT_CONFIG: DrumlinConfig = { entryPoints: [], disabledRules: [] };

/**
 * Written by `drumlin init`, then owned by whoever commits it.
 *
 * Hand-authored rather than serialised from an object so the comments exist.
 * This file is committed and read by people deciding whether a rule misfired
 * or whether they meant to silence it, and a bare `entryPoints: []` explains
 * neither.
 */
const CONFIG_STUB = `schemaVersion: 1

# Recorded so a later run can tell whether the app moved, rather than
# silently re-indexing something else.
app:
  root: .

# Whether Drumlin may act on its own in this project.
#
# Set by \`drumlin activate\` and \`drumlin deactivate\`. Installing the editor
# plugin is a machine-wide act; letting a tool read this repository and
# interrupt your agent is this repository's decision. While this is false, the
# editor hooks and the agent's MCP tools do nothing here. The CLI always works.
loop:
  enabled: false

# Routes reached only by bookmark or emailed link. Listing them here is how
# you stop orphan detection reporting them.
entryPoints: []

rules:
  disabled: []
`;

export function readConfig(root: string): DrumlinConfig {
  const paths = repoPaths(root);
  if (!existsSync(paths.configFile)) return { ...DEFAULT_CONFIG };
  try {
    const parsed = parse(readFileSync(paths.configFile, "utf8")) as Record<
      string,
      unknown
    > | null;
    const entryPoints = parsed?.["entryPoints"];
    const rules = parsed?.["rules"] as Record<string, unknown> | undefined;
    const disabled = rules?.["disabled"];
    return {
      entryPoints: Array.isArray(entryPoints)
        ? entryPoints.filter((item): item is string => typeof item === "string")
        : [],
      disabledRules: Array.isArray(disabled)
        ? disabled.filter((item): item is string => typeof item === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Create `.drumlin/` with its committed subdirectories and a config stub. */
export function initRepo(root: string): { created: string[] } {
  const paths = repoPaths(root);
  const created: string[] = [];

  for (const dir of [paths.dir, paths.contextDir, paths.issuesDir]) {
    if (existsSync(dir)) continue;
    mkdirSync(dir, { recursive: true });
    created.push(dir);
  }

  if (!existsSync(paths.configFile)) {
    writeFileSync(paths.configFile, CONFIG_STUB, "utf8");
    created.push(paths.configFile);
  }

  // The derived cache is disposable and must never be committed.
  const ignoreFile = `${paths.dir}/.gitignore`;
  if (!existsSync(ignoreFile)) {
    writeFileSync(ignoreFile, "cache/\n", "utf8");
    created.push(ignoreFile);
  }

  return { created };
}
