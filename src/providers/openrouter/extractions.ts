import { createHash } from "node:crypto"
import type * as z from "zod"
import { MAX_LITERAL, MAX_TEXT, type EvidenceRef, type ExtractField, type ExtractInput, type ExtractedField, type FIELD_REVIEW } from "../../domain/contracts.js"
import { InferenceError } from "../../domain/errors.js"
import { decimalOf, JsonNumber, parseJson, type Json } from "../../domain/json.js"
import { format, money, roundUp } from "../../domain/money.js"
import { REVIEW_PROFILE } from "../../domain/routing.js"
import type { Adapter, AdapterResult } from "../../runtime/operation.js"
import type { Snapshot } from "../../runtime/sources.js"
import type { RouteCapability } from "./capabilities.js"
import type { TransportResponse } from "./http.js"

// The OpenRouter alpha Extractions adapter (POST /api/alpha/extractions, handoff §3, §5.4, §7, §7.3).
//
// WIRE CONTRACT, documentation-derived and UNVERIFIED: transcribed from the handoff's summary of OpenRouter's guide
// and API reference (A1, A2, A4) on 2026-11-11, never observed from the live API. The request carries `model`, the text
// as `state` (or one image as an ordered `assets` entry), `fields` in the provider's snake_case vocabulary and
// `provider.allow_fallbacks: false`; the answer is `answers` (not `fields`), one entry per requested key. Every route
// stays disabled until the opt-in compatibility canary (scripts/canary-extractions.ts) has confirmed this contract.
//
// Strict where it matters, tolerant where it is harmless: every consumed key, type, probability, span and amount is
// checked, and a changed required field or type is PROVIDER_CONTRACT_CHANGED; unknown metadata is ignored, bounded and
// counted in coverage warnings. Money is read from the answer's literal text (json.ts) and rounded UP to 12 places,
// never through a float. A guess never becomes a value, and an absent confidence stays absent.

export const EXTRACTIONS_PATH = "/api/alpha/extractions"
/** The reviewed wire contract's revision. Part of every request fingerprint. */
export const WIRE_REVISION = "openrouter-alpha-extractions-2026-11-11.1"

type Field = z.infer<typeof ExtractField>
type Input = z.infer<typeof ExtractInput>
type Extracted = z.infer<typeof ExtractedField>
type Evidence = z.infer<typeof EvidenceRef>
type Reason = (typeof FIELD_REVIEW)[number]

const changed = (what: string) => new InferenceError("PROVIDER_CONTRACT_CHANGED", `OpenRouter's extraction answer does not match the reviewed contract (${WIRE_REVISION}): ${what}.`)
const unsupported = (what: string) => new InferenceError("CAPABILITY_UNSUPPORTED", what)
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

// --- Request ----------------------------------------------------------------------------------------------------------

/** One field in the provider's vocabulary. Plugin-only options (`required`) are never sent. */
function wireField(field: Field): Record<string, unknown> {
  const out: Record<string, unknown> = { type: field.type }
  if (field.description !== undefined) out["description"] = field.description
  if (field.nullThreshold !== undefined) out["null_threshold"] = field.nullThreshold
  if (field.type === "number") {
    if (field.decimals !== undefined) out["decimals"] = field.decimals
    if (field.integer !== undefined) out["integer"] = field.integer
    if (field.unit !== undefined) out["unit"] = field.unit
  }
  if (field.type === "list") {
    out["items"] = { type: field.items }
    if (field.maxItems !== undefined) out["max_items"] = field.maxItems
  }
  return out
}

/** The route's own constraints on this request, beyond the shared eligibility (routing.ts). Refused locally. */
function checkConstraints(input: Input, source: Snapshot, route: RouteCapability) {
  for (const [key, field] of Object.entries(input.fields)) {
    if (field.nullThreshold !== undefined && (route.nullThreshold.supported !== true || route.nullThreshold.unsupportedOn.includes(field.type)))
      throw unsupported(`${route.model} does not take a null threshold on the ${field.type} field ${key}.`)
  }
  if (source.modality === "image") {
    const images = route.inputs.images
    if (!images) throw unsupported(`${route.model} takes no image.`)
    if (!images.mimeTypes.includes(source.mimeType)) throw unsupported(`${route.model} does not take ${source.mimeType} images.`)
    // One source is one asset: within the count, each image within its limit, the decoded total within its limit.
    if (images.maxCount !== null && images.maxCount < 1) throw unsupported(`${route.model} takes no image.`)
    if (images.maxBytesEach !== null && source.bytes > images.maxBytesEach) throw new InferenceError("SOURCE_LIMIT", `The image is larger than the ${images.maxBytesEach} bytes ${route.model} takes per image.`)
    if (images.maxBytesTotal !== null && source.bytes > images.maxBytesTotal) throw new InferenceError("SOURCE_LIMIT", `The image is larger than the ${images.maxBytesTotal} decoded bytes ${route.model} takes in total.`)
  } else if (source.modality === "pdf") {
    if (!route.inputs.pdf) throw unsupported(`${route.model} takes no PDF; prepare its text or page images first.`)
  } else if (route.inputs.text !== true) throw unsupported(`${route.model} takes no text.`)
}

function request(raw: unknown, source: Snapshot, route: RouteCapability) {
  const input = raw as Input
  checkConstraints(input, source, route)
  const body: Record<string, unknown> = {
    model: route.model,
    fields: Object.fromEntries(Object.entries(input.fields).map(([key, field]) => [key, wireField(field)])),
    provider: { allow_fallbacks: false },
  }
  if (source.modality === "text") body["state"] = source.text()
  else {
    // An ordered asset list, so evidence that names asset 0 is attributed to this image and no other.
    body["assets"] = [{ type: source.modality === "pdf" ? "file" : "image", media_type: source.mimeType, data: Buffer.from(source.content()).toString("base64") }]
  }
  if (input.referenceDate !== undefined) body["reference_date"] = input.referenceDate
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  if (route.maxRequestBytes !== null && bytes.byteLength > route.maxRequestBytes) throw new InferenceError("CONTEXT_LIMIT", `The request is larger than the ${route.maxRequestBytes} bytes ${route.model} takes.`)
  return { path: EXTRACTIONS_PATH, body: bytes }
}

// --- Quote --------------------------------------------------------------------------------------------------------------

/**
 * The price before sending. A per-request price alone, marked as the whole charge, is an exact upper bound. A per-token
 * price is never bounded locally: a provider's server-side prompt template can add tokens the request body does not
 * contain, so it is an upper bound only through a ceiling the provider documents (`pricing.ceiling`, with its source);
 * otherwise it is an estimate, and the call reserves the whole per-request budget. The estimate itself (per-request
 * price plus the input price for the body's UTF-8 bytes) is exact and rounded UP to 12 places.
 */
function quote(route: RouteCapability, source: Snapshot, input: unknown): ReturnType<Adapter["quote"]> {
  const pricing = route.pricing
  if (!pricing) return { kind: "unavailable" }
  const perToken = pricing.perMillionInputTokens !== undefined || pricing.perMillionOutputTokens !== undefined
  if (perToken && pricing.ceiling !== undefined) return { kind: "upper_bound", amount: format(money(pricing.ceiling.amount)) }
  let units = pricing.perRequest === undefined ? 0n : money(pricing.perRequest).units
  if (pricing.perMillionInputTokens !== undefined) {
    const bodyBytes = BigInt(request(input, source, route).body.byteLength)
    // units are 10^-12 USD; per million tokens means a further 10^-6: the exact product has 18 places.
    const exact = money(pricing.perMillionInputTokens).units * bodyBytes
    const text = exact.toString().padStart(19, "0")
    units += roundUp(`${text.slice(0, -18)}.${text.slice(-18)}`, 12).units
  }
  return { kind: !perToken && pricing.upperBound ? "upper_bound" : "estimate", amount: format({ currency: "USD", units }) }
}

// --- Response -----------------------------------------------------------------------------------------------------------

type JsonObject = { [key: string]: Json }
const isObject = (value: Json | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof JsonNumber)
const entries = (object: JsonObject) => new Map(Object.entries(object))
const MAX_UNKNOWN = 32
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/

function probabilityOf(value: Json | undefined, what: string) {
  if (value === undefined || value === null) return undefined
  if (!(value instanceof JsonNumber) || !Number.isFinite(value.value) || value.value < 0 || value.value > 1) throw changed(`${what} is not a probability`)
  return value.value
}

function count(value: Json | undefined, what: string) {
  if (value === undefined || value === null) return undefined
  if (!(value instanceof JsonNumber) || !/^(?:0|[1-9]\d{0,15})$/.test(value.text) || !Number.isSafeInteger(value.value)) throw changed(`${what} is not a count`)
  return value.value
}

/** An exact, non-negative USD amount from a JSON number, rounded up to the 12 places money keeps. */
function amountOf(value: Json | undefined, what: string) {
  if (value === undefined || value === null) return undefined
  const decimal = value instanceof JsonNumber ? decimalOf(value) : undefined
  if (decimal === undefined || !/^\d{1,12}(?:\.\d+)?$/.test(decimal)) throw changed(`${what} is not a non-negative amount`)
  return format(roundUp(decimal, 12))
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const validDate = (text: string) => {
  const match = DATE.exec(text)
  if (!match) return false
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])
}
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?$/
const DATETIME = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$/
const DURATION = /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?=\d)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/

/** The source text as Unicode code points: offsets index this, never UTF-16 units, bytes or graphemes. */
interface Text {
  readonly points: readonly string[]
  readonly sha256: string
  readonly artifactId?: string
}

function spansOf(value: Json | undefined, what: string, source: Snapshot, text: Text | undefined, reasons: Set<Reason>): Evidence[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 64) throw changed(`${what}.evidence is not a bounded list`)
  const out: Evidence[] = []
  for (const span of value) {
    if (!isObject(span)) throw changed(`${what}.evidence has an entry that is not an object`)
    const fields = entries(span)
    const start = count(fields.get("start"), `${what}.evidence.start`)
    const end = count(fields.get("end"), `${what}.evidence.end`)
    const asset = count(fields.get("asset"), `${what}.evidence.asset`)
    const quoted = fields.get("text")
    if (quoted !== undefined && quoted !== null && typeof quoted !== "string") throw changed(`${what}.evidence.text is not a string`)
    if (text) {
      // Text state: code-point offsets into exactly the text that was sent.
      if (asset !== undefined) throw changed(`${what}.evidence names an asset, but the source was text`)
      if (start === undefined || end === undefined || end < start || end > text.points.length) throw changed(`${what}.evidence is not a span of the source text`)
      const slice = text.points.slice(start, end).join("")
      if (typeof quoted === "string" && quoted !== slice) {
        reasons.add("EVIDENCE_MISMATCH")
        continue
      }
      out.push({ ...(text.artifactId ? { artifactId: text.artifactId } : {}), sourceHash: text.sha256, basis: "exact-text", textRange: { start, end, unit: "unicode-code-point", textHash: sha256(slice) } })
    } else {
      // One asset was sent, as asset 0. Evidence naming another asset is a contract failure, never re-attributed.
      if (asset !== undefined && asset !== 0) throw changed(`${what}.evidence names asset ${asset}, but one asset was sent`)
      reasons.add("EVIDENCE_UNAVAILABLE")
      out.push({ ...(source.artifactId ? { artifactId: source.artifactId } : {}), sourceHash: source.sha256, basis: "unavailable" })
    }
  }
  return out
}

/** Text the result can carry: anything longer is refused here, before settling, never later as an invalid output. */
function text(value: string, what: string) {
  if (value.length > MAX_TEXT) throw changed(`${what} is longer than ${MAX_TEXT} characters`)
  return value
}

/** The significant digits of a plain number literal: "120.00" and "120" both give "12". Undefined with an exponent. */
const digitsOf = (literal: string) => (/[eE]/.test(literal) ? undefined : literal.replace(/^-/, "").replace(".", "").replace(/^0+/, "").replace(/0+$/, ""))

/** The typed value of one answer, or null. A JSON type the field cannot have is a contract failure. */
function typedValue(field: Field, value: Json | undefined, what: string, reasons: Set<Reason>): { value: Extracted["value"]; exact?: string } {
  if (value === undefined) throw changed(`${what} has no value`)
  if (value === null) return { value: null }
  switch (field.type) {
    case "number": {
      if (!(value instanceof JsonNumber) || !Number.isFinite(value.value)) throw changed(`${what} is not a number`)
      if (value.text.length > MAX_LITERAL) throw changed(`${what} is a number literal longer than ${MAX_LITERAL} characters`)
      const fraction = /\.(\d+)/.exec(value.text.replace(/[eE].*$/, ""))?.[1] ?? ""
      const exponent = /[eE]/.test(value.text)
      if (field.integer === true && (exponent ? !Number.isInteger(value.value) : /[1-9]/.test(fraction))) reasons.add("VALIDATION_FAILED")
      if (field.decimals !== undefined && !exponent && fraction.replace(/0+$/, "").length > field.decimals) reasons.add("VALIDATION_FAILED")
      return { value: value.value, exact: value.text }
    }
    case "list": {
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw changed(`${what} is not a list of text`)
      if (field.maxItems !== undefined && value.length > field.maxItems) reasons.add("VALIDATION_FAILED")
      if (value.length > 256) throw changed(`${what} has more than 256 items`)
      return { value: (value as string[]).map((item) => text(item, `${what} item`)) }
    }
    default: {
      if (typeof value !== "string") throw changed(`${what} is not text`)
      text(value, what)
      const valid =
        field.type === "date" ? validDate(value)
        : field.type === "time" ? TIME.test(value)
        : field.type === "datetime" ? DATETIME.test(value) && validDate(DATETIME.exec(value)![1]!)
        : field.type === "duration" ? DURATION.test(value)
        : true
      if (!valid) reasons.add("VALIDATION_FAILED")
      return { value }
    }
  }
}

function guessOf(field: Field, value: Json | undefined, what: string): Extracted["guess"] {
  if (value === undefined || value === null) return undefined
  if (field.type === "number") {
    if (!(value instanceof JsonNumber) || !Number.isFinite(value.value)) throw changed(`${what}.guess is not a number`)
    return value.value
  }
  if (field.type === "list") {
    if (!Array.isArray(value) || value.length > 256 || value.some((item) => typeof item !== "string")) throw changed(`${what}.guess is not a list of text`)
    return (value as string[]).map((item) => text(item, `${what}.guess item`))
  }
  if (typeof value !== "string") throw changed(`${what}.guess is not text`)
  return text(value, `${what}.guess`)
}

const ANSWER_KEYS = new Set(["value", "confidence", "null_probability", "spelling_confidence", "guess", "evidence", "items", "truncated"])

function answerOf(key: string, field: Field, raw: Json | undefined, source: Snapshot, sourceText: Text | undefined, warnings: string[]): { field: Extracted; truncated: boolean } {
  const what = `answers.${key}`
  if (!isObject(raw)) throw changed(`${what} is missing or not an object`)
  const answer = entries(raw)
  const unknown = [...answer.keys()].filter((name) => !ANSWER_KEYS.has(name))
  if (unknown.length > 8) throw changed(`${what} has too many unknown keys`)
  if (unknown.length) warnings.push(`${what}: ${unknown.length} unknown key(s) ignored`)
  const reasons = new Set<Reason>()
  const { value, exact } = typedValue(field, answer.get("value"), what, reasons)
  const confidence = probabilityOf(answer.get("confidence"), `${what}.confidence`)
  const nullProbability = probabilityOf(answer.get("null_probability"), `${what}.null_probability`)
  const spellingConfidence = probabilityOf(answer.get("spelling_confidence"), `${what}.spelling_confidence`)
  const guess = guessOf(field, answer.get("guess"), what)
  const evidence = spansOf(answer.get("evidence"), what, source, sourceText, reasons)
  const truncatedRaw = answer.get("truncated")
  if (truncatedRaw !== undefined && truncatedRaw !== null && typeof truncatedRaw !== "boolean") throw changed(`${what}.truncated is not a boolean`)
  const truncated = truncatedRaw === true

  let items: Extracted["items"]
  const rawItems = answer.get("items")
  if (rawItems !== undefined && rawItems !== null) {
    if (field.type !== "list") throw changed(`${what}.items on a field that is not a list`)
    if (!Array.isArray(rawItems) || !Array.isArray(value) || rawItems.length !== value.length) throw changed(`${what}.items does not match the list's values`)
    items = rawItems.map((item, index) => {
      if (!isObject(item)) throw changed(`${what}.items has an entry that is not an object`)
      const fields = entries(item)
      if (fields.get("value") !== value[index]) throw changed(`${what}.items does not match the list's values`)
      // An item without a span keeps an empty list: its offsets are never invented.
      const itemEvidence = spansOf(fields.get("evidence"), `${what}.items`, source, sourceText, reasons)
      if (itemEvidence.length === 0) reasons.add("EVIDENCE_UNAVAILABLE")
      return { value: value[index]!, evidence: itemEvidence.slice(0, 16) }
    })
  } else if (Array.isArray(value)) items = value.map((item) => ({ value: item, evidence: [] }))

  if (value === null) reasons.add("FIELD_ABSENT")
  if (value === null && field.required === true) reasons.add("REQUIRED_FIELD_ABSENT")
  if (confidence === undefined) reasons.add("CONFIDENCE_MISSING")
  if (value !== null && evidence.length === 0 && !(items && items.some((item) => item.evidence.length > 0))) reasons.add("EVIDENCE_UNAVAILABLE")
  // A located value must be what its evidence quotes: a text value as written, a number by its significant digits
  // ("120.00" matches "EUR 120.00" and "120"). A span with no quoted text is checked against the source the same way.
  const quotes = sourceText && evidence.length > 0 ? evidence.map((item) => sourceText.points.slice(item.textRange!.start, item.textRange!.end).join("")) : []
  if (field.type === "text" && typeof value === "string" && quotes.length > 0 && !quotes.some((quote) => quote.includes(value))) reasons.add("EVIDENCE_MISMATCH")
  if (field.type === "number" && exact !== undefined && quotes.length > 0) {
    const digits = digitsOf(exact)
    if (digits !== undefined && !quotes.some((quote) => (quote.replace(/[^0-9]/g, "").replace(/^0+/, "")).includes(digits))) reasons.add("EVIDENCE_MISMATCH")
  }
  if (truncated) reasons.add("PROVIDER_TRUNCATED")
  return {
    truncated,
    field: {
      type: field.type,
      value,
      ...(exact !== undefined ? { exact } : {}),
      derivation: value === null ? "unknown" : "extracted",
      ...(confidence !== undefined ? { confidence } : {}),
      ...(nullProbability !== undefined ? { nullProbability } : {}),
      ...(spellingConfidence !== undefined ? { spellingConfidence } : {}),
      ...(guess !== undefined ? { guess } : {}),
      evidence: evidence.slice(0, 64),
      ...(items ? { items } : {}),
      review: [...reasons].sort(),
    },
  }
}

const TOP_KEYS = new Set(["id", "model", "answers", "usage", "truncated", "object", "created"])

function usageOf(raw: Json | undefined): AdapterResult["usage"] {
  if (raw === undefined || raw === null) return { charges: [], costStatus: "unknown" }
  if (!isObject(raw)) throw changed("usage is not an object")
  const usage = entries(raw)
  const cost = amountOf(usage.get("cost"), "usage.cost")
  const inputTokens = count(usage.get("prompt_tokens"), "usage.prompt_tokens")
  const outputTokens = count(usage.get("completion_tokens"), "usage.completion_tokens")
  const byok = usage.get("is_byok")
  if (byok !== undefined && byok !== null && typeof byok !== "boolean") throw changed("usage.is_byok is not a boolean")
  const details = usage.get("cost_details")
  if (details !== undefined && details !== null && !isObject(details)) throw changed("usage.cost_details is not an object")
  const upstream = isObject(details) ? amountOf(entries(details).get("upstream_inference_cost"), "usage.cost_details.upstream_inference_cost") : undefined
  // usage.cost is OpenRouter's whole charge; its upstream component is a breakdown, never added to it. Only under BYOK
  // is the upstream amount billed separately, by the upstream provider, and recorded as its own charge.
  const charges: AdapterResult["usage"]["charges"] = [
    ...(cost !== undefined ? [{ party: "platform" as const, currency: "USD", amount: cost, basis: "reported" as const }] : []),
    ...(byok === true && upstream !== undefined ? [{ party: "upstream" as const, currency: "USD", amount: upstream, basis: "reported" as const }] : []),
  ]
  return {
    charges,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    // Under BYOK without a reported upstream amount, part of the cost is unknown.
    costStatus: cost === undefined || (byok === true && upstream === undefined) ? "unknown" : "known",
  }
}

function parse(response: TransportResponse, context: { readonly source: Snapshot; readonly route: RouteCapability; readonly input: unknown }): AdapterResult {
  const input = context.input as Input
  const { source, route } = context
  if (!/^application\/json\b/i.test(response.contentType ?? "")) throw changed("the answer is not application/json")
  let document: Json
  try {
    document = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(response.body))
  } catch (error) {
    if (error instanceof InferenceError) throw error
    throw changed("the answer is not UTF-8")
  }
  if (!isObject(document)) throw changed("the answer is not an object")
  const top = entries(document)
  const warnings: string[] = []
  const unknown = [...top.keys()].filter((key) => !TOP_KEYS.has(key))
  if (unknown.length > MAX_UNKNOWN) throw changed("too many unknown top-level keys")
  if (unknown.length) warnings.push(`${unknown.length} unknown response key(s) ignored`)

  const model = top.get("model")
  // No fallback was allowed: an answer from another model is not this route's answer.
  if (model !== undefined && model !== route.model) throw changed("the answer came from another model")
  const id = top.get("id")
  if (id !== undefined && (typeof id !== "string" || !REQUEST_ID.test(id))) throw changed("id is not a request id")
  const truncatedTop = top.get("truncated")
  if (truncatedTop !== undefined && truncatedTop !== null && typeof truncatedTop !== "boolean") throw changed("truncated is not a boolean")

  const answers = top.get("answers")
  if (!isObject(answers)) throw changed("answers is missing or not an object")
  const answerMap = entries(answers)
  const requested = Object.keys(input.fields)
  const extra = [...answerMap.keys()].filter((key) => !requested.includes(key))
  if (extra.length) throw changed("answers has keys that were not requested")

  const text: Text | undefined =
    source.modality === "text" ? { points: Array.from(source.text()), sha256: source.sha256, ...(source.artifactId ? { artifactId: source.artifactId } : {}) } : undefined
  const fieldsOut = new Map<string, Extracted>()
  let truncated = truncatedTop === true
  for (const [key, field] of Object.entries(input.fields)) {
    const answer = answerOf(key, field, answerMap.get(key), source, text, warnings)
    fieldsOut.set(key, answer.field)
    truncated ||= answer.truncated
  }
  const reasons = new Set<string>(["CALIBRATION_UNAVAILABLE"])
  for (const field of fieldsOut.values()) for (const reason of field.review) reasons.add(reason)
  if (truncated) reasons.add("PROVIDER_TRUNCATED")
  return {
    data: { fields: Object.fromEntries(fieldsOut) },
    usage: usageOf(top.get("usage")),
    coverage: {
      status: text ? (truncated ? "partial" : "complete") : "unknown",
      basis: text ? "provided-text" : "native-file",
      sourceTruncated: false,
      providerTruncated: truncated,
      warnings: [...(text ? [] : ["The provider read the file natively; which parts it covered is not reported."]), ...warnings].slice(0, 32),
    },
    // review-first-v1 is uncalibrated: every result is reviewed, with the reasons that apply.
    review: { required: true, reasons: [...reasons].sort().slice(0, 64), profileVersion: REVIEW_PROFILE },
    ...(typeof id === "string" ? { providerRequestId: id } : {}),
  }
}

/** The adapter the dispatcher runs for `extract`. */
export const extractionsAdapter: Adapter = { operation: "extract", revision: WIRE_REVISION, quote, request, parse }
