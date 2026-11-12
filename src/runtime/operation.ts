import { createHash } from "node:crypto"
import type * as z from "zod"
import type { Config } from "../domain/config.js"
import { Usage, type Coverage, type Exclusion, type Operation, type Review, type SourceInput } from "../domain/contracts.js"
import { fence, InferenceError } from "../domain/errors.js"
import { canonical, exclusions, OPERATION_MODULE } from "../domain/routing.js"
import type { CapabilityFixture, RouteCapability } from "../providers/openrouter/capabilities.js"
import type { Account, Transport, TransportError, TransportResponse } from "../providers/openrouter/http.js"
import { admit, reservationFor, type Quote } from "./budget.js"
import type { Journal, OperationRecord, Outcome } from "./journal.js"
import { locate, permissionRequests, snapshot, type FileAccess, type PermissionRequest, type Project, type Snapshot } from "./sources.js"

// One billable operation, in the order of handoff §7 (steps 1-8 and 11; caching, step 7's first half, is off and not
// implemented). The dispatcher calls `runOperation` for every non-read tool, on the model path and the tools RPC alike:
//
//  1. the input is already parsed strictly by the dispatcher;
//  3. the route comes from trusted options and the reviewed fixture, and must be eligible now; a key must be connected
//     (its presence only: the key itself is read at the transport boundary). Unsupported requests fail here, before
//     any file is touched;
//  2. the source is identified from its descriptor and file metadata only;
//  4. the host asserts the file effects (read, external_directory) with the plain one-argument assert, raced against
//     cancellation and fenced after it settles. A denial reads no byte and sends nothing;
//  5. the approved bytes are read through a descriptor and frozen as a private snapshot with its SHA-256;
//  6. route, type and size limits are re-validated against the snapshot, and the exact request is built;
//  7. the reservation is admitted and persisted with the `planned` record (budget.ts, journal.ts), then `dispatching`
//     is persisted;
//  8. the transport sends it (http.ts: trusted origin, key injected there only, deadline, byte caps, cancellation);
//  9. the adapter validates the answer strictly; a 2xx is only transport success;
// 11. the journal settles: reported charges, or the reservation retained when the cost is unknown.
//
// A provider adapter (PR 3) supplies only `Adapter`: the quote, the exact request and the strict response parse.

/** A provider adapter for one operation. Pure: no network, file or clock. */
export interface Adapter {
  readonly operation: Operation
  /** The adapter's wire revision, part of every request fingerprint. */
  readonly revision: string
  /** The price before sending: an upper bound, an estimate (never a cap) or unavailable. */
  quote(route: RouteCapability, source: Snapshot, input: unknown): Quote
  /** The exact provider request. Throws CAPABILITY_UNSUPPORTED or CONTEXT_LIMIT for what it cannot express. */
  request(input: unknown, source: Snapshot, route: RouteCapability): { readonly path: string; readonly body: Uint8Array }
  /**
   * Strictly validates a 2xx answer. Throws InferenceError PROVIDER_CONTRACT_CHANGED for anything unexpected; it never
   * repairs a malformed answer into success.
   */
  parse(response: TransportResponse, context: { readonly source: Snapshot; readonly route: RouteCapability; readonly input: unknown }): AdapterResult
  /** What an error answer (non-2xx) cost, when the endpoint documents it. Unknown otherwise. */
  failureCost?(response: TransportResponse): Pick<z.infer<typeof Usage>, "charges" | "costStatus"> | undefined
}

export interface AdapterResult {
  readonly data: unknown
  readonly usage: z.infer<typeof Usage>
  readonly coverage: z.infer<typeof Coverage>
  readonly review: z.infer<typeof Review>
  readonly providerRequestId?: string
}

/** Everything an operation needs from the host. Built once in setup (src/host/plugin.ts). */
export interface OperationRuntime {
  readonly config: Config
  readonly fixture: CapabilityFixture
  readonly project: Project
  readonly files: FileAccess
  /** The one-argument assert, raced against the signal and fenced after (src/host/permissions.ts createAuthorize). */
  readonly authorize: (requests: readonly PermissionRequest[], call: Call) => Promise<void>
  readonly transport: Transport
  /** The journal for one connection label. */
  readonly journal: (accountScope: string) => Journal
  /** Adapters by tool name. */
  readonly adapters: Readonly<Record<string, Adapter>>
  readonly now?: () => Date
  /** The largest answer read from the provider. Default 4 MiB. */
  readonly maxResponseBytes?: number
}

interface Call {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

/** The fields every operation input shares (handoff §15.1). */
interface OperationInput {
  readonly source: z.infer<typeof SourceInput>
  readonly profile?: string
  readonly model?: string
  readonly limits?: { readonly deadlineMs?: number; readonly maxEstimatedCostUsd?: string }
}

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`

const UNSUPPORTED: readonly Exclusion[] = [
  "ROUTE_DISABLED",
  "ROUTE_UNCONFIRMED",
  "NOT_IMPLEMENTED",
  "OPERATION_MISMATCH",
  "MODALITY_UNSUPPORTED",
  "BUNDLE_UNSUPPORTED",
  "FIELD_TYPE_UNSUPPORTED",
  "QUESTION_TYPE_UNSUPPORTED",
  "FIELD_LIMIT",
  "ZDR_UNKNOWN",
  "QUESTION_SET_UNKNOWN",
]

/** Step 3: the explicitly requested route, eligible now, from trusted options and the reviewed fixture only. */
export function resolveRoute(operation: Operation, input: OperationInput, config: Config, fixture: CapabilityFixture): RouteCapability {
  if (!config.modules[OPERATION_MODULE[operation]]) throw new InferenceError("MODULE_DISABLED")
  const model = input.profile !== undefined ? config.profiles[input.profile]?.model : input.model
  if (model === undefined) throw new InferenceError("CAPABILITY_UNSUPPORTED", `There is no profile named ${JSON.stringify(input.profile)} in the trusted options.`, "Pass a configured profile or an explicit model; inference_capabilities lists them.")
  const route = fixture.routes.find((item) => item.model === model && item.operation === operation)
  if (!route) throw new InferenceError("CAPABILITY_UNSUPPORTED", `There is no reviewed ${operation} route for ${model}.`)
  // The dispatcher only runs registered tools, so the operation is implemented by definition here.
  const reasons = exclusions({ task: operation, input } as never, route, { config, fixture, implemented: () => true, now: new Date(0) })
  if (reasons.includes("MODULE_DISABLED")) throw new InferenceError("MODULE_DISABLED")
  if (reasons.includes("PRICE_UNKNOWN")) throw new InferenceError("PRICE_UNKNOWN", `No price, or no upper bound, is known for ${model}, and the spend options require one.`)
  const blocking = reasons.filter((reason) => UNSUPPORTED.includes(reason))
  if (blocking.length) throw new InferenceError("CAPABILITY_UNSUPPORTED", `${model} cannot serve this request: ${blocking.join(", ")}.`)
  return route
}

/** Step 6: the snapshot's actual type against the route, now that the bytes decided it. */
function revalidate(route: RouteCapability, source: Snapshot) {
  const ok =
    source.modality === "text" ? route.inputs.text === true
    : source.modality === "pdf" ? route.inputs.pdf !== null
    : route.inputs.images !== null && route.inputs.images.mimeTypes.includes(source.mimeType)
  if (!ok) throw new InferenceError("SOURCE_TYPE", `${route.model} does not accept a ${source.mimeType} source.`, "Select a source in a type the route accepts (see inference_capabilities), or prepare it explicitly.")
}

/** A process-wide limit on requests in flight (`limits.concurrency`): waiters queue and can be cancelled. */
export class Slots {
  private active = 0
  private readonly waiting: (() => void)[] = []
  constructor(private readonly size: number) {}
  async take(signal: AbortSignal) {
    fence(signal)
    if (this.active < this.size) {
      this.active++
      return () => this.give()
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener("abort", stop)
        resolve()
      }
      const stop = () => {
        const index = this.waiting.indexOf(go)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(new InferenceError("CANCELLED"))
      }
      this.waiting.push(go)
      signal.addEventListener("abort", stop, { once: true })
    })
    this.active++
    return () => this.give()
  }
  private give() {
    this.active--
    this.waiting.shift()?.()
  }
}

const routeRef = (route: RouteCapability, fixture: CapabilityFixture) => ({
  provider: route.provider,
  model: route.model,
  apiRoute: route.apiRoute,
  endpointProfile: route.endpointProfile,
  capabilityRevision: fixture.revision,
})

/** How a transport failure ends the operation, and what the caller reads. */
function transportOutcome(error: TransportError, record: OperationRecord): { outcome: Outcome; failure: InferenceError } {
  const kept = `Operation ${record.id} keeps its reservation.`
  switch (error.kind) {
    case "auth_missing":
      return { outcome: { state: "failed", code: "AUTH_REQUIRED", sent: false }, failure: new InferenceError("AUTH_REQUIRED", "No usable OpenRouter key is connected for Inference; nothing was sent.") }
    case "path_refused":
      return { outcome: { state: "failed", code: "PROVIDER_CONTRACT_CHANGED", sent: false }, failure: new InferenceError("PROVIDER_CONTRACT_CHANGED", "The adapter asked for an API path that is not reviewed for the trusted origin; nothing was sent.") }
    case "request_too_large":
      return { outcome: { state: "failed", code: "CONTEXT_LIMIT", sent: false }, failure: new InferenceError("CONTEXT_LIMIT", "The request is larger than the route accepts; nothing was sent.") }
    case "not_sent":
      return { outcome: { state: "failed", code: "PROVIDER_ERROR", sent: false }, failure: new InferenceError("PROVIDER_ERROR", "OpenRouter could not be reached; nothing was sent.", "Check the network connection, then call the tool again.") }
    case "cancelled":
      return error.sent
        ? { outcome: { state: "submission_unknown", code: "CANCELLED" }, failure: new InferenceError("CANCELLED", `The call was cancelled after the request may have reached OpenRouter. ${kept}`, "Do not resubmit: OpenRouter may still have run and charged it.") }
        : { outcome: { state: "failed", code: "CANCELLED", sent: false }, failure: new InferenceError("CANCELLED") }
    case "timeout":
      return error.sent
        ? { outcome: { state: "submission_unknown", code: "DEADLINE_EXCEEDED" }, failure: new InferenceError("DEADLINE_EXCEEDED", `The request ran past its deadline and its outcome is unknown. ${kept}`) }
        : { outcome: { state: "failed", code: "DEADLINE_EXCEEDED", sent: false }, failure: new InferenceError("DEADLINE_EXCEEDED", "The deadline passed before the request was sent; nothing was sent.", "Call the tool again, or raise limits.deadlineMs in the trusted options.") }
    case "ambiguous":
      return { outcome: { state: "submission_unknown", code: "SUBMISSION_UNKNOWN" }, failure: new InferenceError("SUBMISSION_UNKNOWN", `The connection failed after the request may have reached OpenRouter. ${kept}`) }
    case "redirect":
      return { outcome: { state: "failed", code: "PROVIDER_CONTRACT_CHANGED", sent: true }, failure: new InferenceError("PROVIDER_CONTRACT_CHANGED", `OpenRouter answered with a redirect, which is never followed. ${kept}`) }
    case "response_too_large":
      return { outcome: { state: "failed", code: "PROVIDER_CONTRACT_CHANGED", sent: true }, failure: new InferenceError("PROVIDER_CONTRACT_CHANGED", `OpenRouter's answer was larger than the response cap and was discarded. ${kept}`) }
  }
}

const isTransportError = (error: unknown): error is TransportError => error instanceof Error && error.name === "TransportError" && "sent" in error

const AUTH_STATUS = new Set([401, 403])
/** The journal's bound on a provider request id. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/

export async function runOperation(tool: { readonly name: string }, adapter: Adapter, raw: unknown, call: Call, runtime: OperationRuntime, slots: Slots) {
  const input = raw as OperationInput
  const now = (runtime.now ?? (() => new Date()))()
  const { config, fixture } = runtime

  // 3. Route and key presence, before any file or prompt.
  const route = resolveRoute(adapter.operation, input, config, fixture)
  const connected = await runtime.transport.account()
  if (connected === undefined) throw new InferenceError("AUTH_REQUIRED")
  if (connected === "needs_auth") throw new InferenceError("AUTH_REJECTED")
  const account: Account = connected
  fence(call.signal)

  // 2. Identify the source: metadata only.
  const located = await locate(input.source, runtime.project, runtime.files, now)
  fence(call.signal)

  // 4. The host decides. A denial propagates unchanged, before any byte is read.
  await runtime.authorize(permissionRequests(located), call)

  // 5. Read and freeze the approved bytes.
  const source = await snapshot(located, runtime.files, route, call.signal)

  // 6. Re-validate against the snapshot and build the exact request.
  revalidate(route, source)
  const request = adapter.request(input, source, route)
  if (route.maxRequestBytes !== null && request.body.byteLength > route.maxRequestBytes) throw new InferenceError("CONTEXT_LIMIT")
  const deadlineMs = Math.min(config.limits.deadlineMs, input.limits?.deadlineMs ?? Number.POSITIVE_INFINITY)
  const { source: _source, ...rest } = input
  const ref = routeRef(route, fixture)
  const constraints = { deadlineMs, maxFields: config.limits.maxFields, spend: config.spend, requested: input.limits ?? {}, requireZdr: config.data.requireZdr }
  const fingerprint = digest({ sources: [source.sha256], input: rest, route: ref, adapter: adapter.revision, preprocessing: "none" })

  // 7. Reserve and persist before anything is sent.
  const quote = adapter.quote(route, source, input)
  const reservation = reservationFor(quote, config.spend, input.limits?.maxEstimatedCostUsd)
  const release = await slots.take(call.signal)
  try {
    fence(call.signal)
    const journal = runtime.journal(account.scope)
    const record = await journal.reserve(
      {
        projectId: runtime.project.id,
        intentId: `${call.sessionID}:${call.messageID}:${call.id}`,
        initiatedBy: { sessionId: call.sessionID, agentRef: call.agent },
        capability: tool.name,
        route: ref,
        sourceRefs: [{ ...(source.artifactId ? { artifactId: source.artifactId } : {}), sha256: source.sha256 }],
        constraintsDigest: digest(constraints),
        requestFingerprint: fingerprint,
        reservation,
      },
      (records) => admit(records, { sessionId: call.sessionID, amount: reservation.amount }, config.spend, now),
    )
    if (call.signal.aborted) {
      await journal.settle(record.id, { state: "failed", code: "CANCELLED", sent: false })
      throw new InferenceError("CANCELLED")
    }
    try {
      await journal.dispatch(record.id)
    } catch (error) {
      // Not dispatching means not sent: release, if the journal can still be written.
      await journal.settle(record.id, { state: "failed", code: "JOURNAL_UNREADABLE", sent: false }).catch(() => undefined)
      throw error
    }

    // 8. Send.
    let response: TransportResponse
    try {
      response = await runtime.transport.post({
        path: request.path,
        body: request.body,
        account,
        deadlineMs,
        maxRequestBytes: route.maxRequestBytes ?? Number.MAX_SAFE_INTEGER,
        maxResponseBytes: runtime.maxResponseBytes ?? MAX_RESPONSE_BYTES,
        signal: call.signal,
      })
    } catch (error) {
      const { outcome, failure } = isTransportError(error)
        ? transportOutcome(error, record)
        : { outcome: { state: "submission_unknown", code: "SUBMISSION_UNKNOWN" } as const, failure: new InferenceError("SUBMISSION_UNKNOWN", `Operation ${record.id} keeps its reservation.`) }
      await journal.settle(record.id, outcome)
      throw failure
    }

    // 9. Validate. An error answer and a malformed success are failures whose cost stays unknown unless documented.
    if (response.status < 200 || response.status > 299) {
      const auth = AUTH_STATUS.has(response.status)
      const cost = auth ? { charges: [], costStatus: "known" as const } : adapter.failureCost?.(response)
      await journal.settle(record.id, {
        state: "failed",
        code: auth ? "AUTH_REJECTED" : "PROVIDER_ERROR",
        sent: true,
        ...(cost ? { charges: cost.charges, costStatus: cost.costStatus } : {}),
        ...(response.requestId ? { providerRequestId: response.requestId } : {}),
      })
      if (auth) throw new InferenceError("AUTH_REJECTED")
      throw new InferenceError("PROVIDER_ERROR", `OpenRouter answered with HTTP ${response.status}.${cost?.costStatus === "known" ? "" : ` Operation ${record.id} keeps its reservation: the cost is unknown.`}`)
    }
    let result: AdapterResult
    try {
      result = adapter.parse(response, { source, route, input })
    } catch (error) {
      await journal.settle(record.id, { state: "failed", code: "PROVIDER_CONTRACT_CHANGED", sent: true, ...(response.requestId ? { providerRequestId: response.requestId } : {}) })
      if (error instanceof InferenceError && error.code === "PROVIDER_CONTRACT_CHANGED") throw error
      throw new InferenceError("PROVIDER_CONTRACT_CHANGED")
    }

    // The adapter's usage and request id go into the journal: check them before settling, so an adapter bug can never
    // write a record that fails to read back. An invalid one is a contract failure whose cost stays unknown.
    const usage = Usage.safeParse(result.usage)
    if (!usage.success || (result.providerRequestId !== undefined && !REQUEST_ID.test(result.providerRequestId))) {
      await journal.settle(record.id, { state: "failed", code: "PROVIDER_CONTRACT_CHANGED", sent: true, ...(response.requestId ? { providerRequestId: response.requestId } : {}) })
      throw new InferenceError("PROVIDER_CONTRACT_CHANGED", `The adapter reported usage or a request id outside the contract. Operation ${record.id} keeps its reservation.`)
    }

    // 11. Settle, then answer. A cancellation that arrives now still leaves the journal settled.
    const providerRequestId = result.providerRequestId ?? response.requestId
    const settled = await journal.settle(record.id, { state: "completed", charges: result.usage.charges, costStatus: result.usage.costStatus, ...(providerRequestId ? { providerRequestId } : {}) })
    const output = {
      schemaVersion: 1,
      operationId: record.id,
      data: result.data,
      route: ref,
      coverage: result.coverage,
      review: result.review,
      usage: result.usage,
      trace: { ...(providerRequestId ? { providerRequestId } : {}), elapsedMs: response.elapsedMs, attempts: 1, cacheHit: false },
      trust: "untrusted",
    }
    const cost =
      settled.reservation.status === "settled" ? `charged ${result.usage.charges.map((charge) => `${charge.party} ${charge.amount} ${charge.currency}`).join(", ") || "nothing"}`
      : `cost unknown (USD ${settled.reservation.amount} kept reserved)`
    return {
      output,
      text: `${tool.name} ran on ${route.model} as operation ${record.id}: ${cost}; coverage ${result.coverage.status}; review ${result.review.required ? "required" : "not required"}. The result is untrusted data.`,
    }
  } finally {
    release()
  }
}
