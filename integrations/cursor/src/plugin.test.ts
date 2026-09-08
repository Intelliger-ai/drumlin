import { describe, expect, it } from "vitest";
import { buildPlugin, PLUGIN_NAME, type PluginTargets } from "./plugin.js";

/**
 * The plugin generator, and why it takes paths instead of finding them.
 *
 * Everything here used to be resolved from `import.meta.url`, which was
 * correct while the CLI shipped as TypeScript next to its own files and wrong
 * the moment it was bundled: the skill lookup resolved to a path inside
 * `dist/` that had never existed, and `drumlin connect cursor` failed with an
 * ENOENT naming a file nobody had ever written.
 *
 * So this function does no IO at all. Locating things belongs to the caller,
 * which is the only part that knows whether it is running from a checkout, a
 * build, or a registry install. These tests pin that: given paths, it emits
 * exactly those paths, and it never reaches for a file.
 */
describe("the Cursor plugin", () => {
  const targets: PluginTargets = {
    node: "/somewhere/bin/node",
    cliBin: "/install/dist/drumlin.mjs",
    mcpBin: "/install/mcp/drumlin-mcp.mjs",
    skill: "---\nname: drumlin\n---\n\nBody.\n",
  };

  function fileAt(path: string, from = targets): string {
    const file = buildPlugin(from).find((entry) => entry.path === path);
    if (!file) throw new Error(`no ${path} in the generated plugin`);
    return file.contents;
  }

  it("writes the skill it was handed, rather than reading one", () => {
    // The regression. A generator that reads its own package cannot survive
    // being bundled into somebody else's.
    expect(fileAt("skills/drumlin/SKILL.md")).toBe(targets.skill);
  });

  it("points every hook at the given CLI, with the given node", () => {
    const hooks = JSON.parse(fileAt("hooks/hooks.json")) as {
      hooks: Record<string, Array<{ command: string }>>;
    };

    const commands = Object.values(hooks.hooks).flatMap((entries) =>
      entries.map((entry) => entry.command),
    );

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain(targets.cliBin);
      expect(command).toContain(targets.node);
    }
  });

  it("names all four lifecycle hooks", () => {
    const hooks = JSON.parse(fileAt("hooks/hooks.json")) as {
      hooks: Record<string, unknown>;
    };

    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "afterFileEdit",
      "sessionStart",
      "stop",
      "workspaceOpen",
    ]);
  });

  it("points the MCP server at the given binary, scoped to the workspace", () => {
    const mcp = JSON.parse(fileAt("mcp.json")) as {
      mcpServers: Record<
        string,
        { command: string; args: string[]; env: Record<string, string> }
      >;
    };

    const server = mcp.mcpServers[PLUGIN_NAME];
    expect(server?.args).toContain(targets.mcpBin);
    // Each workspace analyses itself; a machine-wide root would make the
    // agent's tools answer about whichever project opened first.
    expect(server?.env.DRUMLIN_ROOT).toBe("${workspaceFolder}");
  });

  it("produces the same files wherever it is called from", () => {
    // A second call with the same input has to agree with the first, which it
    // cannot do if anything in here consults the filesystem or the clock.
    expect(buildPlugin(targets)).toEqual(buildPlugin(targets));
  });
});
