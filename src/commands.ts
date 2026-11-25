import type { Plugin } from "@opencode/plugin"
import { InferenceError, isFailure } from "./domain/errors.js"
import { COMMAND, COMMAND_DESCRIPTION, PLUGIN_NAME } from "./domain/ids.js"
import { statusText, type StatusView } from "./status-text.js"

// `/inference` posts the contract status into the session. It changes nothing: the same answer `status` returns, as text.

type CommandEditor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]

export interface CommandSources {
  readonly synthetic: Plugin.Context["session"]["synthetic"]
  readonly status: () => Promise<StatusView>
}

export function commandTransform(sources: CommandSources) {
  return (editor: CommandEditor) => {
    editor.add({
      name: COMMAND,
      description: COMMAND_DESCRIPTION,
      async execute({ sessionID, delivery }) {
        let text: string
        try {
          text = statusText(await sources.status())
        } catch (error) {
          text = isFailure(error) ? error.message : new InferenceError("STATUS_UNAVAILABLE").message
        }
        await sources.synthetic({ sessionID, delivery, text, description: "Inference status", resume: false, metadata: { source: PLUGIN_NAME } })
      },
    })
  }
}
