import type { Plugin } from "@opencode/plugin"
import { fence, InferenceError } from "./domain/errors.js"
import type { PermissionRequest } from "./runtime/sources.js"

// The file effects the operation pipeline asserts before it reads a source: `read` for the file, and
// `external_directory` for a folder outside the project. The method's own action was asserted by the contract's
// register before the handler ran, so this module asserts nothing else and never re-checks access.

type Assert = Plugin.Context["permission"]["assert"]

export interface AssertCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

/** Waits for one plain assert, but gives up when the signal aborts. A late approval causes no effect. */
async function assertOne(assert: Assert, input: Parameters<Assert>[0], signal: AbortSignal) {
  fence(signal)
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new InferenceError("CANCELLED"))
    signal.addEventListener("abort", abort, { once: true })
    assert(input).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
  fence(signal)
}

/** True for OpenCode's own permission refusals, whose tags carry no contract code. */
function hostDenial(error: unknown): boolean {
  const tag = typeof error === "object" && error !== null ? (error as { _tag?: unknown })._tag : undefined
  return typeof tag === "string" && tag.startsWith("Permission.")
}

/** Assert each file effect in order as the calling tool. A host denial becomes the contract's PERMISSION_DENIED. */
export function createAuthorize(assert: Assert) {
  return async (requests: readonly PermissionRequest[], call: AssertCall) => {
    for (const item of requests) {
      try {
        await assertOne(
          assert,
          {
            sessionID: call.sessionID,
            agent: call.agent,
            source: { type: "tool", messageID: call.messageID, id: call.id },
            action: item.action,
            resources: [...item.resources],
            ...(item.save ? { save: [...item.save] } : {}),
          } as Parameters<Assert>[0],
          call.signal,
        )
      } catch (error) {
        if (error instanceof InferenceError) throw error
        if (hostDenial(error)) throw new InferenceError("PERMISSION_DENIED", `The host refused the ${item.action} access this source needs.`)
        throw error
      }
    }
  }
}
