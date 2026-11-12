import { createHash } from "node:crypto"
import type * as z from "zod"
import { profileModel, type Config } from "./config.js"
import { FIELD_TYPES, type DecideInput, type Exclusion, type ExtractInput, type Operation, type PlanInput, type PlanResult, type ReadInput, type SourceInput } from "./contracts.js"
import { INTEGRATION_ID, type Module } from "./ids.js"
import { fixtureAgeDays, STALE_AFTER_DAYS, type CapabilityFixture, type RouteCapability } from "../providers/openrouter/capabilities.js"

// Deterministic eligibility and the local plan (handoff §5, §15.2). Pure: no file system, no network, no clock except
// the `now` passed in. Routing is explicit: the requested profile or model is the only candidate; every other reviewed
// route is listed as an alternative with its reasons and is never chosen automatically.

export const OPERATION_MODULE: { readonly [O in Operation]: Module } = { extract: "extractions", decide: "decisions", read: "understanding" }
/** The acceptance profile every result uses until a calibrated one exists. */
export const REVIEW_PROFILE = "review-first-v1"

/** What the planner needs to know about the current process. */
export interface PlanContext {
  readonly config: Config
  readonly fixture: CapabilityFixture
  /** Whether the operation's tool is registered and implemented in this version. */
  readonly implemented: (operation: Operation) => boolean
  readonly now: Date
}

type Modality = "text" | "image" | "pdf" | "unknown"
type PlanRequest = z.infer<typeof PlanInput>
type Input = z.infer<typeof ExtractInput> | z.infer<typeof DecideInput> | z.infer<typeof ReadInput>
type Source = z.infer<typeof SourceInput>

// Maps, not records: a key from a file name is looked up without reaching a prototype.
const EXTENSIONS: ReadonlyMap<string, Modality> = new Map(Object.entries({ txt: "text", md: "text", csv: "text", json: "text", pdf: "pdf", png: "image", jpg: "image", jpeg: "image", webp: "image" } as const))
const IMAGE_MIME: ReadonlyMap<string, string> = new Map(Object.entries({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" }))

/** The source's modality, from supplied facts only: the kind, an artifact's declaration, or a file name's extension. */
export function modalityOf(source: Source): { modality: Modality; mimeType?: string; fromName: boolean } {
  switch (source.kind) {
    case "text":
      return { modality: "text", mimeType: "text/plain", fromName: false }
    case "path": {
      const extension = /\.([A-Za-z0-9]+)$/.exec(source.path)?.[1]?.toLowerCase() ?? ""
      const modality = EXTENSIONS.get(extension) ?? "unknown"
      const image = IMAGE_MIME.get(extension)
      return { modality, fromName: true, ...(modality === "pdf" ? { mimeType: "application/pdf" } : image ? { mimeType: image } : {}) }
    }
    case "artifact": {
      const { kind, mimeType } = source.artifact
      const modality: Modality = kind === "text" || kind === "json" ? "text" : kind === "image" ? "image" : kind === "pdf" ? "pdf" : "unknown"
      return { modality, mimeType, fromName: false }
    }
    case "bundle":
      return { modality: "unknown", fromName: false }
  }
}

/** Sorted-key JSON, so equal requests digest equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** The task's digest: everything but source content, which a plan never reads beyond supplied text. */
export function taskDigest(request: PlanRequest) {
  const { source, ...rest } = request.input as Input
  return `sha256:${sha256(canonical({ task: request.task, source: { kind: source.kind }, ...rest }))}`
}

function sourceDescriptor(source: Source): PlanResult["source"] {
  const { mimeType, fromName } = modalityOf(source)
  switch (source.kind) {
    case "text":
      return {
        kind: "text",
        representation: "provided-text",
        bytes: Buffer.byteLength(source.text, "utf8"),
        codePoints: [...source.text].length,
        sha256: sha256(source.text),
        declared: false,
        mimeType: "text/plain",
        unknowns: [],
      }
    case "path":
      return {
        kind: "path",
        representation: "local-file",
        declared: false,
        ...(mimeType ? { mimeType } : {}),
        unknowns: ["bytes", "sha256", fromName ? "mimeType (only guessed from the file name)" : "mimeType"],
      }
    case "artifact":
      return {
        kind: "artifact",
        representation: "artifact",
        bytes: source.artifact.bytes,
        sha256: source.artifact.sha256,
        declared: true,
        mimeType: source.artifact.mimeType,
        unknowns: ["whether the file still matches its declared hash"],
      }
    case "bundle":
      return { kind: "bundle", representation: "bundle", declared: false, unknowns: ["member sizes and hashes"] }
  }
}

/** The documented field kinds a route accepts that this version also accepts. */
const fieldTypesOf = (route: RouteCapability) => route.fieldTypes.filter((type) => (FIELD_TYPES as readonly string[]).includes(type))

/** Every reason `route` cannot serve `request`, in a stable order. Empty means eligible. */
export function exclusions(request: PlanRequest, route: RouteCapability, context: PlanContext): Exclusion[] {
  const { config } = context
  const reasons = new Set<Exclusion>()
  const input = request.input as Input
  if (route.operation !== request.task) reasons.add("OPERATION_MISMATCH")
  if (route.status === "unconfirmed") reasons.add("ROUTE_UNCONFIRMED")
  if (!route.enabled) reasons.add("ROUTE_DISABLED")
  if (!context.implemented(request.task)) reasons.add("NOT_IMPLEMENTED")
  if (!config.modules[OPERATION_MODULE[request.task]]) reasons.add("MODULE_DISABLED")

  if (input.source.kind === "bundle") reasons.add("BUNDLE_UNSUPPORTED")
  else {
    const { modality, mimeType } = modalityOf(input.source)
    const supported =
      modality === "text" ? route.inputs.text === true
      : modality === "pdf" ? route.inputs.pdf !== null
      : modality === "image" ? route.inputs.images !== null && (mimeType === undefined || route.inputs.images.mimeTypes.includes(mimeType))
      : true // unknown until execution reads the bytes
    if (!supported) reasons.add("MODALITY_UNSUPPORTED")
  }

  if (request.task === "extract") {
    const fields = Object.values(request.input.fields)
    const types = fieldTypesOf(route)
    if (fields.some((field) => !types.includes(field.type) || (field.type === "list" && !route.listItemTypes.includes(field.items)))) reasons.add("FIELD_TYPE_UNSUPPORTED")
    if (fields.length > config.limits.maxFields) reasons.add("FIELD_LIMIT")
    // A null threshold only where the route documents it, and never on a kind it refuses: an unknown is a refusal.
    const thresholds = route.nullThreshold
    if (fields.some((field) => field.nullThreshold !== undefined && (thresholds.supported !== true || thresholds.unsupportedOn.includes(field.type)))) reasons.add("NULL_THRESHOLD_UNSUPPORTED")
  }
  if (request.task === "decide") {
    if (request.input.questionSet !== undefined) reasons.add("QUESTION_SET_UNKNOWN")
    const questions = Object.values(request.input.questions ?? {})
    const imageSource = input.source.kind !== "bundle" && modalityOf(input.source).modality === "image"
    if (questions.some((question) => !route.questionTypes.includes(question.type) || (question.type === "box" && (!imageSource || route.inputs.images === null))))
      reasons.add("QUESTION_TYPE_UNSUPPORTED")
    if (questions.length > config.limits.maxFields) reasons.add("FIELD_LIMIT")
  }

  if ((config.spend.requirePricedRoute && route.pricing === null) || (config.spend.requireUpperBound && route.pricing?.upperBound !== true)) reasons.add("PRICE_UNKNOWN")
  if (config.data.requireZdr && route.zdr !== "supported") reasons.add("ZDR_UNKNOWN")
  return [...reasons]
}

const routeRef = (route: RouteCapability, fixture: CapabilityFixture) => ({
  provider: route.provider,
  model: route.model,
  apiRoute: route.apiRoute,
  endpointProfile: route.endpointProfile,
  capabilityRevision: fixture.revision,
})

/** A quote from the fixture's price, if any. A token estimate is an estimate, never a ceiling. */
export function quoteFor(route: RouteCapability | undefined, source: PlanResult["source"], context: PlanContext): PlanResult["quote"] {
  const ageDays = fixtureAgeDays(context.fixture, context.now)
  const freshness = { reviewedOn: context.fixture.reviewedOn, ageDays, stale: ageDays > STALE_AFTER_DAYS }
  const pricing = route?.pricing
  if (!route || !pricing) {
    return { kind: "unavailable", basis: "none", freshness, unknowns: [route ? `no price for ${route.model} in the reviewed sources` : "no route is selected"] }
  }
  const unknowns: string[] = []
  // A per-token price is a ceiling only through a ceiling the provider documents (see RouteCapability.pricing.ceiling).
  if ((pricing.perMillionInputTokens !== undefined || pricing.perMillionOutputTokens !== undefined) && pricing.ceiling !== undefined)
    return { kind: "upper_bound", currency: "USD", amount: pricing.ceiling.amount, basis: "fixture", priceRevision: pricing.revision, freshness, unknowns }
  if (pricing.perRequest !== undefined && pricing.perMillionInputTokens === undefined && pricing.perMillionOutputTokens === undefined) {
    return pricing.upperBound
      ? { kind: "upper_bound", currency: "USD", amount: pricing.perRequest, basis: "fixture", priceRevision: pricing.revision, freshness, unknowns }
      : { kind: "estimate", currency: "USD", amount: pricing.perRequest, basis: "fixture", priceRevision: pricing.revision, freshness, unknowns: ["the provider may charge differently"] }
  }
  if (source.codePoints === undefined || pricing.perMillionInputTokens === undefined) {
    return { kind: "unavailable", basis: "none", freshness, unknowns: ["input size is unknown until execution reads the source"] }
  }
  // A rough token range from code points: between one token per 6 and one per 2 code points. Output tokens and provider
  // passes are not known before the call, so they are listed, not guessed.
  const tokens = { min: Math.ceil(source.codePoints / 6), max: Math.ceil(source.codePoints / 2) }
  const perRequest = pricing.perRequest === undefined ? 0n : toMicros(pricing.perRequest)
  const rate = toMicros(pricing.perMillionInputTokens)
  const cost = (count: number) => fromMicros(perRequest + (rate * BigInt(count) + 999_999n) / 1_000_000n)
  unknowns.push("output tokens", "provider passes")
  return { kind: "estimate", currency: "USD", range: { min: cost(tokens.min), max: cost(tokens.max) }, basis: "fixture", priceRevision: pricing.revision, freshness, unknowns }
}

/** Decimal USD strings to integer micro-dollars and back: money is never added as a binary float. */
export const toMicros = (value: string) => {
  const [whole, fraction = ""] = value.split(".")
  return BigInt(whole!) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6))
}
export const fromMicros = (value: bigint) => {
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "")
  return fraction ? `${whole}.${fraction}` : `${whole}`
}

const TOOL_OF: { readonly [O in Operation]: string } = { extract: "inference_extract", decide: "inference_decide", read: "inference_read" }

/** The local plan. It never opens a file, calls a provider, refreshes a catalog or reads a key. */
export function plan(request: PlanRequest, context: PlanContext): PlanResult {
  const { config, fixture } = context
  const input = request.input as Input
  const requested = { ...(input.profile === undefined ? {} : { profile: input.profile }), ...(input.model === undefined ? {} : { model: input.model }) }
  const reasons: Exclusion[] = []
  let model = input.model
  if (input.profile !== undefined) {
    model = profileModel(config, input.profile)
    if (model === undefined) reasons.push("PROFILE_UNKNOWN")
  }
  const candidates = fixture.routes.filter((route) => route.operation === request.task)
  const chosen = model === undefined ? undefined : fixture.routes.find((route) => route.model === model && route.operation === request.task) ?? fixture.routes.find((route) => route.model === model)
  if (model !== undefined && chosen === undefined) reasons.push("MODEL_UNKNOWN")
  const assess = (route: RouteCapability) => {
    const found = exclusions(request, route, context)
    return { route: routeRef(route, fixture), eligible: found.length === 0, exclusions: found }
  }
  const selected = chosen === undefined ? undefined : assess(chosen)
  const alternatives = candidates.filter((route) => route !== chosen).map(assess)
  const source = sourceDescriptor(input.source)
  const { modality } = input.source.kind === "bundle" ? { modality: "unknown" as const } : modalityOf(input.source)

  const preparation: PlanResult["preparation"] = []
  if (input.source.kind === "path")
    preparation.push({ step: "authorize-and-snapshot", owner: "inference execution", reason: "Execution asks the host before reading the file, then snapshots, hashes and sniffs it. Plan does not open it." })
  if (input.source.kind === "artifact")
    preparation.push({ step: "verify-artifact", owner: "inference execution", reason: "Execution asserts file access, then checks the file against the artifact's declared size and hash." })
  if (input.source.kind === "bundle") preparation.push({ step: "bundle", owner: "not supported", reason: "No route in this version accepts a bundle of prepared evidence." })
  if (modality === "pdf" && chosen && chosen.inputs.pdf === null)
    preparation.push({ step: "pdf-text or pdf-render", owner: "a media preparation tool (planned)", reason: `${chosen.model} takes no PDF: send its text layer or rendered page images instead.` })

  const coverage: PlanResult["coverage"] =
    modality === "text" && input.source.kind === "text" ? { expected: "complete", basis: "provided-text", notes: ["The supplied text is the whole source representation."] }
    : modality === "pdf" ? { expected: "unknown", basis: "native-file", notes: ["A provider's native PDF reading may skip scanned pages; coverage is reported after execution."] }
    : { expected: "unknown", notes: ["Coverage is known only after execution reads the source."] }

  const review: PlanResult["review"] = {
    likely: true,
    reasons: ["CALIBRATION_UNAVAILABLE", ...(input.acceptanceProfile !== undefined && input.acceptanceProfile !== REVIEW_PROFILE ? ["ACCEPTANCE_PROFILE_UNKNOWN"] : [])],
    profileVersion: REVIEW_PROFILE,
  }
  const tool = TOOL_OF[request.task]
  const executionReasons = [
    ...(context.implemented(request.task) ? [] : [`${tool} is not implemented in this version, so nothing can be sent.`]),
    ...(selected && !selected.eligible ? [`The selected route is not eligible: ${selected.exclusions.join(", ")}.`] : []),
    ...(reasons.length ? [`The request has no route: ${reasons.join(", ")}.`] : []),
  ]
  return {
    schemaVersion: 1,
    task: request.task,
    digest: taskDigest(request),
    source,
    route: {
      status: reasons.length === 0 && selected?.eligible ? "eligible" : "ineligible",
      requested,
      reasons,
      ...(selected ? { selected } : {}),
      alternatives,
    },
    preparation,
    transmission: chosen
      ? { provider: chosen.provider, apiRoute: chosen.apiRoute, representation: modality === "text" ? "text" : modality === "unknown" ? "unknown until execution" : modality, credentialScope: INTEGRATION_ID }
      : null,
    limits: {
      maxFields: config.limits.maxFields,
      deadlineMs: Math.min(config.limits.deadlineMs, input.limits?.deadlineMs ?? Number.POSITIVE_INFINITY),
      concurrency: config.limits.concurrency,
      route: chosen
        ? {
            maxRequestBytes: chosen.maxRequestBytes,
            effectiveContextTokens: chosen.effectiveContextTokens,
            maxImages: chosen.inputs.images?.maxCount ?? null,
            maxImageBytes: chosen.inputs.images?.maxBytesEach ?? null,
            maxImageBytesTotal: chosen.inputs.images?.maxBytesTotal ?? null,
            maxPdfFiles: chosen.inputs.pdf?.maxCount ?? null,
          }
        : {},
    },
    quote: quoteFor(chosen, source, context),
    coverage,
    review,
    execution: { available: executionReasons.length === 0, tool, reasons: executionReasons },
    unknowns: [
      "the capability fixture is documentation-derived and not verified against the live API",
      ...(chosen?.effectiveContextTokens === null ? ["the endpoint's effective context limit"] : []),
      "whether a failed or timed-out call is charged",
    ],
  }
}
