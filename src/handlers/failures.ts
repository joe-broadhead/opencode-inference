import { refusal, RegisterError, type Refusal } from "@we-the-rebel-alliance/plugin-contract/register"
import { InferenceError, type FailureCode } from "../domain/errors.js"

// One mapping from the plugin's own failures to the contract's error table (contract §12). A code the table does not
// hold is refused as UNAVAILABLE: the plugin never invents a code, and the contract's next step is always present.

const CONTRACT_CODE: Readonly<Record<FailureCode, Refusal["code"]>> = {
  INPUT_INVALID: "INPUT_INVALID",
  OPTIONS_INVALID: "OPTIONS_INVALID",
  HOST_UNTESTED: "HOST_UNTESTED",
  MODULE_DISABLED: "SOURCE_DISABLED",
  TOOL_UNAVAILABLE: "UNAVAILABLE",
  CLOSED: "UNAVAILABLE",
  CANCELLED: "UNAVAILABLE",
  STATUS_UNAVAILABLE: "UNAVAILABLE",
  OUTPUT_INVALID: "SCHEMA_VIOLATION",
  RULES_NOT_ADDED: "UNAVAILABLE",
  INTEGRATION_NOT_REGISTERED: "NEEDS_SIGN_IN",
  ROUTE_NOT_VERIFIED: "INPUT_INVALID",
  CAPABILITY_UNSUPPORTED: "INPUT_INVALID",
  UNSAFE_PATH: "INPUT_INVALID",
  SOURCE_CHANGED: "INPUT_INVALID",
  SOURCE_TYPE: "INPUT_INVALID",
  SOURCE_LIMIT: "TOO_LARGE",
  CONTEXT_LIMIT: "TOO_LARGE",
  AUTH_REQUIRED: "NEEDS_SIGN_IN",
  AUTH_REJECTED: "NEEDS_SIGN_IN",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  PRICE_UNKNOWN: "INPUT_INVALID",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  JOURNAL_LOCKED: "UNAVAILABLE",
  JOURNAL_UNREADABLE: "UNAVAILABLE",
  PROVIDER_ERROR: "UNAVAILABLE",
  PROVIDER_CONTRACT_CHANGED: "UNAVAILABLE",
  SUBMISSION_UNKNOWN: "UNAVAILABLE",
  DEADLINE_EXCEEDED: "UNAVAILABLE",
}

/** True when the failure means the account needs a sign-in: the one case a handler nudges the bus about. */
export const needsSignIn = (error: unknown): boolean => error instanceof InferenceError && (error.code === "AUTH_REQUIRED" || error.code === "AUTH_REJECTED")

/** The contract refusal for one failure. Unknown errors are UNAVAILABLE with their redacted first line. */
export function failureOf(error: unknown): RegisterError {
  if (error instanceof RegisterError) return error
  if (error instanceof InferenceError) return new RegisterError(refusal(CONTRACT_CODE[error.code] ?? "UNAVAILABLE", error.what, error.hint))
  const what = error instanceof Error ? error.message.split(/\r?\n/, 1)[0] ?? "the call failed" : String(error)
  return new RegisterError(refusal("UNAVAILABLE", what, "Try again; if it keeps failing, check the plugin's status."))
}

/** Throw the contract refusal for one failure. */
export function fail(error: unknown): never {
  throw failureOf(error)
}
