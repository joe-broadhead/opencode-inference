/**
 * Inference's part of the tools RPC (`inference.core.tools`): the plugin value that the source contract's `tools-rpc`
 * module takes. The module (`@we-the-rebel-alliance/source-contract/tools-rpc`, bundled into `dist/index.js`) is the
 * transport the plugin family shares:
 *
 *   POST /api/rpc/inference.core.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * A script runs as a session and the agent it names; the rule for the method's permission action is resolved before
 * dispatch, and only `allow` runs. Inference has no MCP server, so every method is a plugin-owned tool.
 * `scriptMethods` (src/host/scripting.ts) builds them from the registry in setup, where they have the shared dispatcher.
 */
import { toolsRpcId, type Failure, type McpResult, type MethodSpec, type NextSteps, type ShapeCall, type ToolsRpcPlugin } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { FAILURES, isFailure } from "../domain/errors.js"
import { PLUGIN_ID as INFERENCE_ID } from "../domain/ids.js"

/** The plugin's id. The RPC id is `<PLUGIN_ID>.tools`: `inference.core.tools`. */
export const PLUGIN_ID = INFERENCE_ID

/** `inference.core.tools`. Scripts call it by name, so it never changes. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/**
 * Inference has no MCP server, so every method is a plugin-owned tool: the table is the registry (src/domain/registry.ts),
 * whose classes it carries. `scriptMethods` (src/host/scripting.ts) builds the methods from that table in setup, where
 * they have the shared dispatcher.
 */
export const METHODS: readonly MethodSpec[] = []

/** Inference has no `execute.before` hook: a script's arguments reach the dispatcher exactly as a model's do. */
export function shapeInput(_method: string, input: unknown, _call: ShapeCall): unknown {
  return input
}

/** Inference has no `execute.after` hook: a tool's structured output is the same on both paths. */
export function shapeResult(_method: string, result: McpResult, _call: ShapeCall): McpResult {
  return result
}

/** The next step for each code. Each is one sentence that ends with a full stop. Inference has no MCP methods. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the action to the session's agent or to the session, or use a session whose agent allows it.",
  CANCELLED: "Call the method again if you still need the result.",
}

/** An Inference failure from the dispatcher: its code, what happened and its next step, as the model reads them. */
export function pluginError(error: unknown): Failure | undefined {
  if (!isFailure(error)) return undefined
  return { code: error.code, what: error.what, next: error.hint ?? FAILURES.TOOL_UNAVAILABLE[1] }
}

/** Inference's plugin value for the tools RPC. No method has a resource resolver. */
export const PLUGIN: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, shapeInput, shapeResult, pluginError }