import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveEngine, type ResolvedEngine } from "@drumlin/client";
import { changedFiles, readActivation } from "@drumlin/repo";
import { ReadOnlyEngine } from "./readonly.js";
import { TOOLS, TOOL_ANNOTATIONS, type ToolContext } from "./tools.js";

export const MCP_SERVER_VERSION = "0.1.0";

/**
 * The MCP server.
 *
 * A thin adapter: it holds no state, runs no analysis, and reaches nothing the
 * CLI cannot. Every tool call goes through the same `Engine` interface as
 * `drumlin check`, so an agent and a developer are always looking at the same
 * graph.
 *
 * Tools only, no resources. Cursor lists resources as supported but documents
 * no way to browse or reference one, and describes tools as the only surface an
 * agent picks up on its own. The `drumlin://` URIs in Context/14 can wait for
 * a host that documents them.
 */

export interface ServerOptions {
  /**
   * The workspace. Taken from the environment, never from a tool argument.
   *
   * An agent that could name its own root could point the tools at any
   * repository on the machine, and every answer would still look plausible.
   */
  root: string;
  app?: string;
  /** Do not start a daemon; only use one already running. */
  spawn?: boolean;
}

export function resolveRoot(env: NodeJS.ProcessEnv, cwd: string): string {
  return (
    env["DRUMLIN_ROOT"] ?? env["WORKSPACE_FOLDER_PATHS"]?.split(",")[0] ?? cwd
  );
}

/**
 * Refuse to answer in a project nobody activated.
 *
 * The MCP server is declared once in the plugin and inherits whatever
 * workspace Cursor opens, so without this an agent could read any repository
 * on the machine as long as the developer had installed the plugin for one.
 * Phrased as an instruction because the agent is the one reading it and cannot
 * fix this itself — the developer has to.
 */
export function requireActivation(root: string): void {
  const activation = readActivation(root);
  if (activation.active) return;

  throw new Error(
    activation.initialised
      ? "Drumlin is set up in this project but not activated, so its tools are " +
          "off. Ask the developer to run `drumlin activate` here. Until then, do " +
          "not assume anything about this app's UX graph."
      : "Drumlin is not set up in this project, so its tools are off. Ask the " +
          "developer to run `drumlin init` and then `drumlin activate` here. " +
          "Until then, do not assume anything about this app's UX graph.",
  );
}

export async function createServer(
  options: ServerOptions,
): Promise<{ server: McpServer; engine: ResolvedEngine }> {
  const engine = await resolveEngine({
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  });

  const server = new McpServer(
    { name: "drumlin", version: MCP_SERVER_VERSION },
    {
      instructions:
        "Drumlin analyses this workspace as a UX graph: screens, states, actions, " +
        "and the transitions between them. Use it to learn what links to a route " +
        "before you change navigation, and to check what your edits broke. " +
        "It is read-only — Drumlin records issues, and only a human closes them.",
    },
  );

  const context: ToolContext = {
    // Wrapped, not passed through. See ReadOnlyEngine: the tool list being
    // read-only today is a test, and this makes it a boundary.
    engine: new ReadOnlyEngine(engine.engine),
    root: options.root,
    ...(options.app ? { app: options.app } : {}),
    changedFiles: async () => changedFiles({ root: options.root }),
  };

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: TOOL_ANNOTATIONS,
      },
      async (input: unknown) => {
        try {
          // Checked per call rather than at startup, because the developer can
          // activate midway through a session and should not have to restart
          // the editor to be taken seriously.
          requireActivation(options.root);
          const text = await tool.run(
            context,
            (input ?? {}) as Record<string, unknown>,
          );
          return { content: [{ type: "text" as const, text }] };
        } catch (error) {
          // Reported as tool content rather than thrown: an agent can act on
          // "run drumlin init first", and cannot act on a protocol error.
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
          };
        }
      },
    );
  }

  return { server, engine };
}

export async function main(argv: readonly string[] = []): Promise<void> {
  const root = flag(argv, "--root") ?? resolveRoot(process.env, process.cwd());
  const app = flag(argv, "--app");

  const { server, engine } = await createServer({
    root,
    ...(app ? { app } : {}),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (): void => {
    engine.close();
    void server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}
