import type { Plugin } from "@opencode/plugin"
import { INTEGRATION_ID, INTEGRATION_KEY_LABEL, INTEGRATION_NAME, type ConnectionState } from "../domain/ids.js"

// The plugin-owned OpenRouter key integration, through public host APIs only: a `key` method on the plugin's own
// integration id, so the user adds it with /connect (choosing "OpenRouter for Inference") or `opencode auth login
// inference-openrouter`. It is separate from OpenCode's own OpenRouter model provider: a plugin cannot assume the coding
// model's credential is available to it.
//
// This version never reads the key. Status asks only whether a connection is active. The transport boundary (PR 2/3)
// is the one place that will call `connection.resolve`, at dispatch time.

type Integration = Plugin.Context["integration"]

/** Adds the key entry to /connect. The returned registration is disposed on cleanup. */
export function registerIntegration(integration: Pick<Integration, "transform">) {
  return integration.transform((editor) => {
    editor.update(INTEGRATION_ID, (item) => {
      item.name = INTEGRATION_NAME
    })
    editor.method.update({
      integrationID: INTEGRATION_ID,
      method: {
        type: "key",
        label: INTEGRATION_KEY_LABEL,
        form: [
          {
            key: "note",
            type: "string",
            title: "What it is used for",
            description: "Inference's extraction and decision calls to OpenRouter, in a later release. This version stores the key and never sends it.",
            required: false,
          },
        ],
      },
    })
  })
}

export const CONNECT_STEP = `Run /connect and choose ${INTEGRATION_NAME}, then enter an OpenRouter API key.`
const REJECTED_STEP = `OpenRouter did not accept the saved key. ${CONNECT_STEP}`

/** Connected or not, from the active connection alone. The key is never resolved, returned or logged. */
export async function connectionState(integration: Pick<Integration, "connection">): Promise<{ state: ConnectionState; next?: string }> {
  try {
    const connection = await integration.connection.active(INTEGRATION_ID)
    if (!connection) return { state: "not_connected", next: CONNECT_STEP }
    if (connection.status) return { state: "needs_auth", next: REJECTED_STEP }
    return { state: "connected" }
  } catch {
    return { state: "unknown", next: "OpenCode did not report the OpenRouter connection. Restart OpenCode, then run /inference-status." }
  }
}
