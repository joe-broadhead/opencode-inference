// The plugin's failures: `CODE: what happened. Next step: …` with one next step. No message carries a key, source text,
// a field value the caller sent or a signed URL. Host permission errors are not these and pass through unchanged.

/** What happened and the next step, per code. The codes PR 2 and later add (§11.4) join this table when they are raised. */
export const FAILURES = {
  INPUT_INVALID: ["The tool input is invalid.", "Correct the named fields against the tool's schema and call it again."],
  OPTIONS_INVALID: ["The plugin options are invalid.", "Fix the named option in the Inference plugin options in opencode.json, then restart OpenCode."],
  HOST_UNTESTED: ["This OpenCode version is outside the range Inference supports.", "Use a tested OpenCode release, or set the plugin option allowUntestedHost: true to run anyway."],
  MODULE_DISABLED: ["The module behind this tool is turned off in the plugin options.", "Set modules.<name> to true in the Inference plugin options, then restart OpenCode."],
  TOOL_UNAVAILABLE: ["This tool is not available in this location right now.", "Call inference_status to see what is available, then retry."],
  CLOSED: ["The Inference plugin is shutting down.", "Retry after OpenCode has reloaded the plugin."],
  CANCELLED: ["The call was cancelled.", "Call the tool again if you still need the result."],
  STATUS_UNAVAILABLE: ["Inference status could not be read.", "Run /inference-status in a session to see the error, or check the OpenCode server log."],
  OUTPUT_INVALID: ["The tool produced a result that does not match its own schema.", "Report it with the inference_status output; this is a bug in the plugin."],
  RULES_NOT_ADDED: ["The default permission rules could not be added.", "Restart OpenCode."],
  INTEGRATION_NOT_REGISTERED: ["The OpenRouter key entry could not be added to /connect.", "Restart OpenCode."],
} as const satisfies Record<string, readonly [message: string, hint: string]>

export type FailureCode = keyof typeof FAILURES

export interface Failure {
  readonly code: FailureCode
  /** What happened, ending with a full stop. */
  readonly message: string
  /** The one next step. */
  readonly hint: string
}

export const formatFailure = (failure: Pick<Failure, "code" | "message" | "hint">) => `${failure.code}: ${failure.message} Next step: ${failure.hint}`

/** An Inference failure: an Error with an upper-case code. `message` is the formatted line. */
export class InferenceError extends Error implements Failure {
  readonly code: FailureCode
  readonly hint: string
  readonly what: string
  constructor(code: FailureCode, what?: string, hint?: string) {
    const [defaultWhat, defaultHint] = FAILURES[code]
    const message = what ?? defaultWhat
    const next = hint ?? defaultHint
    super(formatFailure({ code, message, hint: next }))
    this.name = "InferenceError"
    this.code = code
    this.what = message
    this.hint = next
  }
}

/** True for an Inference failure. Host errors are tagged (`_tag`) and are not. */
export function isFailure(error: unknown): error is InferenceError {
  return error instanceof InferenceError
}

/** Rejects once the signal has aborted: a late approval or a late result can cause no effect. */
export function fence(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new InferenceError("CANCELLED")
}
