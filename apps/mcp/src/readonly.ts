import {
  AGENT_READABLE_METHODS,
  type Engine,
  type EngineMethod,
  type EngineMethods,
} from "@drumlin/engine";

/**
 * An engine that can only answer the four questions an agent is allowed to ask.
 *
 * Defence in depth, and worth the twenty lines. The tool surface is already
 * fixed by a test, but every tool holds a full `Engine`, so the guarantee
 * "an agent cannot accept its own findings" currently rests on nobody ever
 * adding a fifth tool that calls `issue.accept`. That is a convention, and a
 * convention is not a boundary.
 *
 * With this, adding such a tool fails at runtime with a message naming the
 * policy, rather than silently working and handing the agent the grading pen.
 */

const ALLOWED = new Set<string>(AGENT_READABLE_METHODS);

export class ReadOnlyEngine implements Engine {
  constructor(private readonly inner: Engine) {}

  request<M extends EngineMethod>(
    method: M,
    params: EngineMethods[M]["params"],
  ): Promise<EngineMethods[M]["result"]> {
    if (!ALLOWED.has(method)) {
      // Rejected rather than filtered, and loudly. A silent no-op here would
      // read to the caller as "the issue was accepted".
      return Promise.reject(
        new Error(
          `${method} is not available to an agent. Drumlin's MCP surface is ` +
            `read-only: only ${[...ALLOWED].sort().join(", ")} can be called. ` +
            `Accepting an issue is a human decision made with \`drumlin accept\`.`,
        ),
      );
    }
    return this.inner.request(method, params);
  }
}
