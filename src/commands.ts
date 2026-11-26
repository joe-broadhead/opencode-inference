import type { Plugin } from "@opencode/plugin"
import { unguardedAgents, type AgentLike, type PermissionRule, type UnguardedAgentsResult } from "@we-the-rebel-alliance/plugin-contract/access"
import type { MethodCall, MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { InferenceError, isFailure } from "./domain/errors.js"
import { COMMAND, COMMAND_DESCRIPTION, PLUGIN_NAME } from "./domain/ids.js"
import { statusText, type StatusView } from "./status-text.js"

/**
 * The command's status answer: the same handler the status method runs, with the registration no longer exposing its
 * rules. A failed agent list is a problem in the answer, never zero unguarded agents; this is the path the command
 * exercises and the status handler reports.
 */
export async function commandStatus(status: MethodHandler, agentList: () => Promise<{ readonly data: readonly AgentLike[] }>, rules: readonly PermissionRule[]): Promise<StatusView> {
  const call = {
    unguardedAgents: async (): Promise<UnguardedAgentsResult> => {
      try {
        return { ok: true, agents: unguardedAgents((await agentList()).data, rules) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  }
  return (await status.run({}, call as unknown as MethodCall)) as StatusView
}

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
