import { actionOf, jsonSchemaOf, TOOLS, type ToolSpec } from "../domain/registry.js"
import type { RunTool } from "../runtime/dispatch.js"
import { registerToolsRpc, type PluginMethod, type ToolsRpcContext } from "./tools-rpc.js"

/**
 * The tools RPC `inference.core.tools`: every registered tool as a method of the same name, with the registry's class,
 * so a script can call it with no model, as a session and the agent it names (src/host/tools-rpc.ts, docs/scripting.md).
 *
 * Each method runs the shared dispatcher with the script's call as the invocation, which parses the input strictly and
 * re-checks availability at execution: `available()` below is for describe only.
 */
export function scriptMethods(runTool: RunTool, available: (name: string) => string | undefined = () => undefined, tools: readonly ToolSpec[] = TOOLS): PluginMethod[] {
  return tools.map((tool) => ({
    kind: "plugin",
    name: tool.name,
    action: actionOf(tool.name),
    class: tool.class,
    description: tool.description,
    input: jsonSchemaOf(tool.input, "input"),
    output: jsonSchemaOf(tool.output, "output"),
    available: () => available(tool.name),
    run: async (input, call) => (await runTool(tool.name, input, call)).output,
  }))
}

type Disposable = { readonly dispose: () => Promise<void> }

/**
 * Registers the tools RPC. Every registration the shared module makes (its RPC and its ask-refusing hook) is handed to
 * `track` as soon as it exists, so the plugin's cleanup stack disposes it even when the shared module fails part-way,
 * for instance when the hook cannot be registered after the RPC was.
 */
export async function registerScripting(
  ctx: ToolsRpcContext,
  runTool: RunTool,
  track: (registration: Disposable) => void,
  available?: (name: string) => string | undefined,
  tools: readonly ToolSpec[] = TOOLS,
) {
  const tracked = {
    ...ctx,
    rpc: {
      ...ctx.rpc,
      register: async (contract: never, handlers: never) => {
        const registration = await ctx.rpc.register(contract, handlers)
        track(registration)
        return registration
      },
    },
    permission: {
      ...ctx.permission,
      hook: async (name: never, callback: never) => {
        const registration = await ctx.permission.hook(name, callback)
        track(registration)
        return registration
      },
    },
  } as unknown as ToolsRpcContext
  await registerToolsRpc(tracked, { methods: scriptMethods(runTool, available, tools) })
}
