import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { repoPaths } from "./paths.js";

/**
 * Whether Drumlin may act on its own in a project.
 *
 * Installing the Cursor plugin is a machine-wide act, but consenting to have a
 * tool read your code and interrupt your agent is a per-project one. Without
 * this switch the two were the same decision: the plugin's hooks fire in every
 * workspace, so enabling Drumlin for one repository enabled it for all of them,
 * including repositories belonging to other people.
 *
 * So the gate is explicit and local. `drumlin activate` writes it, and the
 * surfaces that speak without being asked — the hooks, and the MCP tools an
 * agent can call — refuse to do anything until it is set.
 *
 * The CLI is deliberately not gated. Running `drumlin check` is the developer
 * asking a direct question, which is how you would evaluate Drumlin on a
 * project before deciding to activate it.
 */
export interface Activation {
  /** `.drumlin/` exists, so issue ids and decisions have somewhere to live. */
  initialised: boolean;
  /** The developer ran `drumlin activate` here. */
  active: boolean;
  /** When it was activated, for telling a deliberate choice from a default. */
  activatedAt?: string;
}

export function readActivation(root: string): Activation {
  const paths = repoPaths(root);
  if (!existsSync(paths.dir)) return { initialised: false, active: false };
  if (!existsSync(paths.configFile)) return { initialised: true, active: false };

  try {
    const document = parseDocument(readFileSync(paths.configFile, "utf8"));
    const enabled = document.getIn(["loop", "enabled"]);
    const at = document.getIn(["loop", "activatedAt"]);

    return {
      initialised: true,
      // Strictly true. A missing, malformed, or absent key means inactive,
      // because the failure mode of guessing wrong is a tool that reads a
      // stranger's repository.
      active: enabled === true,
      ...(typeof at === "string" ? { activatedAt: at } : {}),
    };
  } catch {
    // An unparseable config is not consent.
    return { initialised: true, active: false };
  }
}

/**
 * Flip the switch, preserving whatever else is in the file.
 *
 * Edited through the YAML document rather than parse-and-restringify because
 * `config.yaml` is committed and hand-edited: reformatting someone's comments
 * out of existence to set one boolean is not an acceptable trade.
 */
export function setActivation(root: string, active: boolean): Activation {
  const paths = repoPaths(root);
  if (!existsSync(paths.dir)) {
    throw new Error(
      "No .drumlin/ directory here. Run `drumlin init` first, so there is " +
        "somewhere for issue ids and decisions to live.",
    );
  }

  const source = existsSync(paths.configFile)
    ? readFileSync(paths.configFile, "utf8")
    : "";
  const document = parseDocument(source);

  const at = new Date().toISOString();
  document.setIn(["loop", "enabled"], active);
  if (active) document.setIn(["loop", "activatedAt"], at);
  else document.deleteIn(["loop", "activatedAt"]);

  writeFileSync(paths.configFile, document.toString(), "utf8");

  return {
    initialised: true,
    active,
    ...(active ? { activatedAt: at } : {}),
  };
}
