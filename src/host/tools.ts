import type { Plugin } from "@opencode/plugin"
import { Error as ToolError } from "@opencode/plugin/promise/tool"
import { isFailure } from "../domain/errors.js"
import { NAMESPACE } from "../domain/ids.js"
import { actionOf, NAMESPACE_DESCRIPTION, TOOLS } from "../domain/registry.js"
import type { RunTool } from "../runtime/dispatch.js"

type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]

/** Inference failures become tool errors with the code; host errors, permission errors included, pass through. */
export async function mapFailures<T>(work: () => Promise<T>) {
  try {
    return await work()
  } catch (error) {
    if (!isFailure(error)) throw error
    throw new ToolError({ message: error.message, metadata: { code: error.code, hint: error.hint } })
  }
}

/**
 * The model tools: a thin projection of the registry onto the host's tool editor. Each tool's execute is the shared
 * dispatcher, so the model path and the tools RPC run the same checks. The transform is synchronous and replayed on
 * every rebuild.
 */
export function toolTransform(runTool: RunTool, registrable: (name: string) => boolean = () => true) {
  return (editor: ToolEditor) => {
    editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION })
    for (const tool of TOOLS) {
      if (!registrable(tool.name)) continue
      editor.add({
        name: tool.name,
        description: tool.description,
        input: tool.input,
        output: tool.output,
        options: { namespace: NAMESPACE, permission: actionOf(tool.name) },
        execute: (input, context) =>
          mapFailures(async () => {
            const invocation = { sessionID: context.sessionID, agent: context.agent, messageID: context.messageID, id: context.id, signal: context.signal }
            const result = await runTool(tool.name, input, invocation)
            return { output: result.output as never, content: result.text }
          }),
      })
    }
  }
}
