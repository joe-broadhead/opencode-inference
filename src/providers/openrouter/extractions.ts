import { createHash } from "node:crypto"
import type * as z from "zod"
import { MAX_LITERAL, MAX_TEXT, type EvidenceRef, type ExtractField, type ExtractInput, type ExtractedField, type FIELD_REVIEW } from "../../domain/contracts.js"
import { InferenceError } from "../../domain/errors.js"
import { JsonNumber, parseJson, type Json } from "../../domain/json.js"
import { REVIEW_PROFILE } from "../../domain/routing.js"
import type { Adapter, AdapterResult } from "../../runtime/operation.js"
import type { Snapshot } from "../../runtime/sources.js"
import type { RouteCapability } from "./capabilities.js"
import type { TransportResponse } from "./http.js"
import { answeredBy, countOf, entries, isObject, probabilityOf as sharedProbability, quoteOf, REQUEST_ID, usageOf as sharedUsage } from "./wire.js"

// The OpenRouter alpha Extractions adapter (POST /api/alpha/extractions, handoff §3, §5.4, §7, §7.3).
//
// WIRE CONTRACT, from OpenRouter's API reference (A4, its OpenAPI schemas ExtractionsRequest and ExtractionsResponse)
// and guide (A2) as read on 2026-11-12, and checked against the structure of one live Clairic answer (the canary of
// 2026-11-12, recorded in test/fixtures/providers/openrouter-extractions/clairic-live-shape.json). The request carries
// `model`, the text as `state` (or one file as an `assets` map entry with no `state`), `fields` in the provider's
// vocabulary (`instructions`, `null_threshold`, `decimals`, `integer`, `unit`, a list's `items` as a string) and
// `provider.allow_fallbacks: false`. The answer is `answers`, one per requested key, each with its `type`, `value`,
// `guess`, `p_null`, `confidence`, `spell_confidence`, `source`, and a code-point `span` (`spans`, one per item, for a
// list); `model` names the route's model id or its reviewed canonical slug; usage reports `input_tokens`,
// `output_tokens` and `cost`. Every route stays disabled until the opt-in canary (scripts/canary-extractions.ts) passes.
//
// Strict where it matters, tolerant where it is harmless: every consumed key, type, probability, span and amount is
// checked, and a changed required field or type is PROVIDER_CONTRACT_CHANGED; unknown metadata is ignored, bounded and
// counted in coverage warnings. Money is read from the answer's literal text (json.ts) and rounded UP to 12 places,
// never through a float. A guess never becomes a value, and an absent confidence stays absent.

export const EXTRACTIONS_PATH = "/api/alpha/extractions"
/** The reviewed wire contract's revision. Part of every request fingerprint. */
export const WIRE_REVISION = "openrouter-alpha-extractions-2026-11-12.1"

type Field = z.infer<typeof ExtractField>
type Input = z.infer<typeof ExtractInput>
type Extracted = z.infer<typeof ExtractedField>
type Evidence = z.infer<typeof EvidenceRef>
type Reason = (typeof FIELD_REVIEW)[number]

const changed = (what: string) => new InferenceError("PROVIDER_CONTRACT_CHANGED", `OpenRouter's extraction answer does not match the reviewed contract (${WIRE_REVISION}): ${what}.`)
const unsupported = (what: string) => new InferenceError("CAPABILITY_UNSUPPORTED", what)
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

// --- Request ----------------------------------------------------------------------------------------------------------

/**
 * One field in the provider's vocabulary (A4: every field schema has additionalProperties false). The description is
 * sent as `instructions`; plugin-only options (`required`, a list's `maxItems`, checked locally) are never sent.
 */
function wireField(field: Field): Record<string, unknown> {
  const out: Record<string, unknown> = { type: field.type }
  if (field.description !== undefined) out["instructions"] = field.description
  if (field.nullThreshold !== undefined) out["null_threshold"] = field.nullThreshold
  if (field.type === "number") {
    if (field.decimals !== undefined) out["decimals"] = field.decimals
    if (field.integer !== undefined) out["integer"] = field.integer
    if (field.unit !== undefined) out["unit"] = field.unit
  }
  if (field.type === "list") out["items"] = field.items
  return out
}

/** The documented format of a file asset (A2: png, jpg, jpeg, webp, pdf), or undefined for any other type. */
function assetFormat(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return "png"
    case "image/jpeg":
      return "jpeg"
    case "image/webp":
      return "webp"
    case "application/pdf":
      return "pdf"
    default:
      return undefined
  }
}

/** The route's own constraints on this request, beyond the shared eligibility (routing.ts). Refused locally. */
function checkConstraints(input: Input, source: Snapshot, route: RouteCapability) {
  for (const [key, field] of Object.entries(input.fields)) {
    if (field.nullThreshold !== undefined && (route.nullThreshold.supported !== true || route.nullThreshold.unsupportedOn.includes(field.type)))
      throw unsupported(`${route.model} does not take a null threshold on the ${field.type} field ${key}.`)
    // A duration answer is a number in a requested unit on this endpoint (A4), not the ISO 8601 text this version's
    // result carries: refused until the result can say which unit a duration is in.
    if (field.type === "duration") throw unsupported(`The duration field ${key} is not supported on ${route.model} in this version: its answer is a number in a unit the result cannot carry yet.`)
    if (field.type === "number" && field.decimals !== undefined && field.decimals > 6) throw unsupported(`${route.model} keeps at most 6 decimal places; the field ${key} asks for ${field.decimals}.`)
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
    // One file, file-only: no `state`, so the asset is read without a reference (A2).
    const format = assetFormat(source.mimeType)
    if (format === undefined) throw unsupported(`${route.model} does not take ${source.mimeType} files.`)
    // The one asset's key is `source`; with no `state`, the assets are read without a reference (A2).
    body["assets"] = { source: { type: source.modality === "pdf" ? "document" : "image", format, data_base64: Buffer.from(source.content()).toString("base64") } }
  }
  if (input.referenceDate !== undefined) body["reference_date"] = input.referenceDate
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  if (route.maxRequestBytes !== null && bytes.byteLength > route.maxRequestBytes) throw new InferenceError("CONTEXT_LIMIT", `The request is larger than the ${route.maxRequestBytes} bytes ${route.model} takes.`)
  return { path: EXTRACTIONS_PATH, body: bytes }
}

// --- Quote --------------------------------------------------------------------------------------------------------------

const quote = (route: RouteCapability, source: Snapshot, input: unknown) => quoteOf(route, () => request(input, source, route).body.byteLength)

// --- Response -----------------------------------------------------------------------------------------------------------

const MAX_UNKNOWN = 32
const probabilityOf = (value: Json | undefined, what: string) => sharedProbability(value, what, changed)
const count = (value: Json | undefined, what: string) => countOf(value, what, changed)

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

/**
 * One documented span, `[start, end)` in Unicode code points of exactly the text sent (A4), as evidence. A span on an
 * answer to a file is refused: the file was not text, and an offset into it would be invented.
 */
function spanOf(value: Json | undefined, what: string, text: Text | undefined): Evidence | undefined {
  if (value === undefined || value === null) return undefined
  if (!text) throw changed(`${what} is a text span, but the source was a file`)
  if (!Array.isArray(value) || value.length !== 2) throw changed(`${what} is not a [start, end] pair`)
  const start = count(value[0], `${what} start`)
  const end = count(value[1], `${what} end`)
  if (start === undefined || end === undefined || end < start || end > text.points.length) throw changed(`${what} is not a span of the source text`)
  const slice = text.points.slice(start, end).join("")
  return { ...(text.artifactId ? { artifactId: text.artifactId } : {}), sourceHash: text.sha256, basis: "exact-text", textRange: { start, end, unit: "unicode-code-point", textHash: sha256(slice) } }
}

/** The quoted source text of a piece of evidence. */
const quotedText = (text: Text, evidence: Evidence) => text.points.slice(evidence.textRange!.start, evidence.textRange!.end).join("")

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

/** The documented answer keys (A4), and `truncated`, which an answer may carry; estimate and forecast keys are not ours. */
const ANSWER_KEYS = new Set(["type", "value", "guess", "p_null", "confidence", "spell_confidence", "source", "span", "spans", "confidences", "unit", "truncated"])

function answerOf(key: string, field: Field, raw: Json | undefined, source: Snapshot, sourceText: Text | undefined, warnings: string[]): { field: Extracted; truncated: boolean } {
  const what = `answers.${key}`
  if (!isObject(raw)) throw changed(`${what} is missing or not an object`)
  const answer = entries(raw)
  const unknown = [...answer.keys()].filter((name) => !ANSWER_KEYS.has(name))
  if (unknown.length > 8) throw changed(`${what} has too many unknown keys`)
  if (unknown.length) warnings.push(`${what}: ${unknown.length} unknown key(s) ignored`)
  // Each answer names its type (A4: required); it must be the type asked for, or the value is not this field's.
  if (answer.get("type") !== field.type) throw changed(`${what}.type is not ${field.type}`)
  const reasons = new Set<Reason>()
  const { value, exact } = typedValue(field, answer.get("value"), what, reasons)
  const confidence = probabilityOf(answer.get("confidence"), `${what}.confidence`)
  const nullProbability = probabilityOf(answer.get("p_null"), `${what}.p_null`)
  const spellingConfidence = probabilityOf(answer.get("spell_confidence"), `${what}.spell_confidence`)
  const guess = guessOf(field, answer.get("guess"), what)
  // Where the answer was read from: the state text for a text source, the file for a file source; never the other.
  const read = answer.get("source")
  const expectedSource = source.modality === "text" ? "state" : source.modality === "pdf" ? "document" : "image"
  if (read !== undefined && read !== null && read !== expectedSource) throw changed(`${what}.source is not ${expectedSource}`)
  const truncatedRaw = answer.get("truncated")
  if (truncatedRaw !== undefined && truncatedRaw !== null && typeof truncatedRaw !== "boolean") throw changed(`${what}.truncated is not a boolean`)
  const truncated = truncatedRaw === true

  let evidence: Evidence[] = []
  let items: Extracted["items"]
  if (field.type === "list") {
    if (answer.get("span") !== undefined && answer.get("span") !== null) throw changed(`${what}.span on a list, which has spans`)
    const values = Array.isArray(value) ? (value as string[]) : undefined
    const rawSpans = answer.get("spans")
    let spans: (Evidence | undefined)[] = []
    if (rawSpans !== undefined && rawSpans !== null) {
      if (!Array.isArray(rawSpans) || !values || rawSpans.length !== values.length) throw changed(`${what}.spans does not match the list's values`)
      spans = rawSpans.map((span) => spanOf(span, `${what}.spans entry`, sourceText))
    }
    const confidences = answer.get("confidences")
    if (confidences !== undefined && confidences !== null) {
      if (!Array.isArray(confidences) || !values || confidences.length !== values.length) throw changed(`${what}.confidences does not match the list's values`)
      confidences.forEach((item) => probabilityOf(item, `${what}.confidences entry`))
    }
    if (values) {
      // An item without a span keeps an empty list: its offsets are never invented.
      items = values.map((item, index) => {
        const span = spans[index]
        if (!span) reasons.add("EVIDENCE_UNAVAILABLE")
        else if (sourceText && !quotedText(sourceText, span).includes(item)) reasons.add("EVIDENCE_MISMATCH")
        return { value: item, evidence: span ? [span] : [] }
      })
    }
  } else {
    if (answer.get("spans") !== undefined && answer.get("spans") !== null) throw changed(`${what}.spans on a field that is not a list`)
    if (answer.get("confidences") !== undefined && answer.get("confidences") !== null) throw changed(`${what}.confidences on a field that is not a list`)
    const span = spanOf(answer.get("span"), `${what}.span`, sourceText)
    if (span) evidence = [span]
  }

  if (value === null) reasons.add("FIELD_ABSENT")
  if (value === null && field.required === true) reasons.add("REQUIRED_FIELD_ABSENT")
  if (confidence === undefined) reasons.add("CONFIDENCE_MISSING")
  if (value !== null && evidence.length === 0 && !(items && items.some((item) => item.evidence.length > 0))) reasons.add("EVIDENCE_UNAVAILABLE")
  // A located value must be what its evidence quotes: a text value as written, a number by its significant digits
  // ("120.00" matches "EUR 120.00" and "120"); a date, time or datetime as written.
  const quotes = sourceText ? evidence.map((item) => quotedText(sourceText, item)) : []
  if (typeof value === "string" && quotes.length > 0 && !quotes.some((quote) => quote.includes(value))) reasons.add("EVIDENCE_MISMATCH")
  if (field.type === "number" && exact !== undefined && quotes.length > 0) {
    const digits = digitsOf(exact)
    if (digits !== undefined && !quotes.some((quote) => quote.replace(/[^0-9]/g, "").replace(/^0+/, "").includes(digits))) reasons.add("EVIDENCE_MISMATCH")
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
      evidence,
      ...(items ? { items } : {}),
      review: [...reasons].sort(),
    },
  }
}

/** The documented top-level keys (A4). */
const TOP_KEYS = new Set(["id", "model", "provider", "answers", "usage", "truncated", "state_text"])

const usageOf = (raw: Json | undefined) => sharedUsage(raw, changed)

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
  if (!answeredBy(model, route)) throw changed("the answer came from another model")
  const id = top.get("id")
  if (id !== undefined && (typeof id !== "string" || !REQUEST_ID.test(id))) throw changed("id is not a request id")
  const provider = top.get("provider")
  if (provider !== undefined && provider !== null && (typeof provider !== "string" || provider.length > 128)) throw changed("provider is not a provider name")
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
