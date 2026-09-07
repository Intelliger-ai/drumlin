/**
 * @drumlin/mcp — the local MCP server.
 *
 * Four read-only tools over `packages/client`, spoken over stdio. See
 * Context/14 MCP and Local Daemon API.md for the surface, and `src/tools.ts`
 * for why nothing here can write.
 */
export { ReadOnlyEngine } from "./readonly.js";
export {
  createServer,
  main,
  MCP_SERVER_VERSION,
  resolveRoot,
  type ServerOptions,
} from "./server.js";
export {
  TOOLS,
  TOOL_NAMES,
  TOOL_ANNOTATIONS,
  type ToolContext,
  type ToolDefinition,
  type ToolName,
} from "./tools.js";
