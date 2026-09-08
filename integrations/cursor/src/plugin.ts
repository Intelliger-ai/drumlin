/**
 * The Cursor plugin, as files.
 *
 * Cursor's own plugin format rather than the open Agent Plugins standard: that
 * standard carries skills and MCP servers only, and the hooks are the whole
 * point here. A plugin is a directory, so `drumlin connect cursor` writes what
 * this returns into `~/.cursor/plugins/local/drumlin/`.
 *
 * Generated rather than committed verbatim because two values are only known at
 * install time: the absolute path to this checkout, and which Node is running
 * it. A committed manifest would work on one machine.
 */

export const PLUGIN_NAME = "drumlin";
export const PLUGIN_VERSION = "0.1.0";

export interface PluginTargets {
  /** Absolute path to `node`. */
  node: string;
  /** Absolute path to the `drumlin` CLI entry point. */
  cliBin: string;
  /** Absolute path to the MCP server entry point. */
  mcpBin: string;
  /**
   * The agent skill, as text.
   *
   * Passed in rather than read from beside this module, because there is no
   * "beside this module" once the CLI is bundled — the reference resolved to a
   * path inside `dist/` that had never existed. Reading it is the caller's
   * problem, which is also where the knowledge of the layout already lives.
   */
  skill: string;
}

export interface PluginFile {
  path: string;
  contents: string;
}

export function buildPlugin(targets: PluginTargets): PluginFile[] {
  return [
    {
      path: ".cursor-plugin/plugin.json",
      contents: json(manifest()),
    },
    { path: "hooks/hooks.json", contents: json(hooks(targets)) },
    { path: "mcp.json", contents: json(mcp(targets)) },
    { path: "skills/drumlin/SKILL.md", contents: targets.skill },
  ];
}

function manifest(): unknown {
  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description:
      "UX intelligence for this workspace: a graph of screens, states, and " +
      "transitions, with findings while you code.",
  };
}

/**
 * The hook wiring.
 *
 * Four events, and the reasoning for each is in `apps/cli/src/commands/hook.ts`.
 * Three properties of this file matter more than the rest:
 *
 * `timeout` is set explicitly everywhere. Cursor documents the default only as
 * "platform default", with no number, and a hook whose ceiling nobody knows is
 * a hook that can hang an editor.
 *
 * `failClosed` is off everywhere. A daemon that is down should mean no feedback,
 * not a broken editor — this is a tool that reports on UX debt, and it does not
 * get to stop someone working.
 *
 * The `afterFileEdit` matcher keys on the tool that did the writing, not on the
 * path, so filtering to source files happens inside the script.
 */
function hooks(targets: PluginTargets): unknown {
  const command = (event: string): string =>
    `${quote(targets.node)} ${quote(targets.cliBin)} hook ${event}`;

  return {
    version: 1,
    hooks: {
      // Fires outside any session, on open and on folder change. Starts the
      // daemon parsing so the first prompt does not pay for a cold index.
      workspaceOpen: [
        { command: command("workspace-open"), timeout: 5, failClosed: false },
      ],
      // Snapshots the finding baseline and returns the session id via `env`,
      // which Cursor propagates to every later hook in the conversation.
      sessionStart: [
        { command: command("session-start"), timeout: 20, failClosed: false },
      ],
      // Fire-and-forget. This event has no defined output, so there is nothing
      // to wait for; the script posts the path and returns.
      afterFileEdit: [
        {
          command: command("file-edit"),
          matcher: "Write|TabWrite",
          timeout: 5,
          failClosed: false,
        },
      ],
      // Cannot block. Returns `followup_message` for new high and critical
      // findings, which Cursor submits as the next user message.
      stop: [{ command: command("stop"), timeout: 30, failClosed: false }],
    },
  };
}

/**
 * The MCP server declaration.
 *
 * `DRUMLIN_ROOT` is interpolated by Cursor, which is how the server learns
 * which repository it is serving. Taking the root from a tool argument instead
 * would let an agent point the tools at any checkout on the machine.
 */
function mcp(targets: PluginTargets): unknown {
  return {
    mcpServers: {
      drumlin: {
        type: "stdio",
        command: targets.node,
        args: [targets.mcpBin],
        env: {
          DRUMLIN_ROOT: "${workspaceFolder}",
        },
      },
    },
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Quote a path for a shell command, since a home directory can have spaces. */
function quote(path: string): string {
  return /[\s"'\\$`]/.test(path)
    ? `"${path.replace(/(["$`\\])/g, "\\$1")}"`
    : path;
}
