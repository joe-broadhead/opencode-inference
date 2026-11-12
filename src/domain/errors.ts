// The plugin's failures: `CODE: what happened. Next step: …` with one next step. No message carries a key, source text,
// a field value the caller sent or a signed URL. Host permission errors are not these and pass through unchanged.

/**
 * What happened and the next step, per code. The §11.4 codes join this table when the runtime raises them: the
 * synchronous operation path raises the ones below; OUTPUT_EXPIRED, OUTPUT_UNAVAILABLE and CANCEL_UNSUPPORTED arrive
 * with asynchronous operations, and REVIEW_REQUIRED is a result disposition (`review.required`), never a failure.
 */
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
  // The operation path (handoff §7, §11.4).
  CAPABILITY_UNSUPPORTED: ["The selected route cannot serve this request.", "Choose a supported field, modality or profile with inference_plan, or prepare the source explicitly."],
  UNSAFE_PATH: ["The source path is not a plain regular file this call may read.", "Re-select the current regular file by a path without symbolic links or '..'."],
  SOURCE_CHANGED: ["The source changed between approval and reading, or no longer matches its declaration.", "Re-select the current regular file and call the tool again."],
  SOURCE_TYPE: ["The source's bytes are not a type this call accepts, or do not match its declared type.", "Select a file whose content matches its name, in a type the route accepts (see inference_capabilities)."],
  SOURCE_LIMIT: ["The source is larger than the route accepts.", "Select a smaller range or use an evaluated chunking strategy."],
  CONTEXT_LIMIT: ["The request is larger than the route accepts.", "Select a smaller range or fewer fields, or use an evaluated chunking strategy."],
  AUTH_REQUIRED: ["No OpenRouter key is connected for Inference.", "Run /connect and choose OpenRouter for Inference, then enter an OpenRouter API key."],
  AUTH_REJECTED: ["OpenRouter did not accept the connected key.", "Run /connect and choose OpenRouter for Inference to replace the key."],
  PRICE_UNKNOWN: ["No price, or no upper bound, is known for this route, and the spend options require one.", "Select a priced, affordable route, or change spend.requirePricedRoute or spend.requireUpperBound in the trusted options."],
  BUDGET_EXCEEDED: ["This call would exceed a spend budget.", "Select a priced, affordable route, wait for the rolling window, or raise the limit in the trusted spend options."],
  JOURNAL_LOCKED: ["The operation journal is locked by another process and was not taken over.", "Make sure no other OpenCode process is using Inference, then remove the lock file named above and retry."],
  JOURNAL_UNREADABLE: ["The operation journal could not be read or written.", "Check the Inference state folder's permissions and free space; do not delete the journal while operations are unsettled."],
  PROVIDER_ERROR: ["OpenRouter answered with an error.", "Retry later; a failed call may still have been charged, so check usage before retrying."],
  PROVIDER_CONTRACT_CHANGED: ["OpenRouter's response did not match the reviewed contract for this route.", "Disable that adapter revision and update its fixtures and schema; do not retry the same call."],
  SUBMISSION_UNKNOWN: ["The request may have reached OpenRouter, but its outcome is unknown.", "Reconcile the existing operation; do not resubmit."],
  DEADLINE_EXCEEDED: ["The call ran past its deadline.", "Check whether OpenRouter received it before calling again; its reservation is kept."],
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
