import type { Plugin } from "@opencode/plugin"
import { INTEGRATION_ID, INTEGRATION_KEY_LABEL, INTEGRATION_NAME, type ConnectionState } from "../domain/ids.js"

// The plugin-owned OpenRouter key integration, through public host APIs only: a `key` method on the plugin's own
// integration id, so the user adds it with /connect (choosing "OpenRouter key for Inference") or `opencode auth login
// inference-openrouter`. It is separate from OpenCode's own OpenRouter model provider and from the OpenRouter plugin's
// "OpenRouter tools" sign-in: a plugin cannot assume the coding model's credential is available to it.
//
// Status asks only whether a connection is active and never reads the key. The transport boundary
// (src/providers/openrouter/http.ts) is the one place that resolves it: at dispatch, for a call on an enabled route
// (inference_extract and inference_decide), and it sends it only to OpenRouter.

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
