import type { Plugin } from "@opencode/plugin"
import { InferenceError, isFailure } from "../domain/errors.js"
import { COMMANDS, PLUGIN_ID, type StatusView } from "../domain/ids.js"
import { formatStatus } from "../rpc.js"

type CommandEditor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]

export interface CommandSources {
  readonly synthetic: Plugin.Context["session"]["synthetic"]
  readonly status: () => Promise<StatusView>
}

/** `/inference-status` posts the status into the session. It changes nothing. */
export function commandTransform(sources: CommandSources) {
  return (editor: CommandEditor) => {
    editor.add({
      name: COMMANDS.status,
      description: "Inference status: the OpenRouter connection, modules, capability fixture, spend limits and permissions",
      async execute({ sessionID, delivery }) {
        let text: string
        try {
          text = formatStatus(await sources.status())
        } catch (error) {
          text = isFailure(error) ? error.message : new InferenceError("STATUS_UNAVAILABLE").message
        }
        await sources.synthetic({ sessionID, delivery, text, description: "Inference status", resume: false, metadata: { source: PLUGIN_ID } })
      },
    })
  }
}
