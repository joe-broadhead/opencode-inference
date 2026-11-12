import type * as z from "zod"
import { accept, questionSetDigest, REVIEW_FIRST, type ResolvedProfile, type Unaccepted } from "../../domain/acceptance.js"
import { acceptanceProfileOf, questionSetOf, type Config } from "../../domain/config.js"
import type { DecidedAnswer, DecideInput, QuestionInput } from "../../domain/contracts.js"
import { InferenceError } from "../../domain/errors.js"
import { JsonNumber, parseJson, type Json } from "../../domain/json.js"
import { IMPLEMENTED_QUESTION_TYPES, REVIEW_PROFILE } from "../../domain/routing.js"
import type { Adapter, AdapterResult } from "../../runtime/operation.js"
import type { Snapshot } from "../../runtime/sources.js"
import type { RouteCapability } from "./capabilities.js"
import type { TransportResponse } from "./http.js"
import { entries, isObject, probabilityOf, quoteOf, REQUEST_ID, usageOf } from "./wire.js"

// The OpenRouter alpha Decisions adapter (POST /api/alpha/decisions, handoff §5, §8, §15.1, §16.3).
//
// WIRE CONTRACT, documentation-derived and UNVERIFIED (D1-D4 as summarised in the handoff, 2026-11-11; never observed
// from the live API): the request carries `model`, the text as `state`, named `questions` (noul, choice with `options`,
// score with ordered `levels`) and `provider.allow_fallbacks: false`; the answer is `answers`, one per question key:
// `{ probability }` for noul, `{ choice, distribution? }` for choice, `{ score, distribution? }` for score (the expected
// zero-based level index), each with an optional `confidence`, or `{ refusal }` when the model declines the question.
// Every route stays disabled until the opt-in canary (scripts/canary-decisions.ts) confirms it.
//
// Probability semantics are kept exactly: a distribution is checked (known labels, 0..1, a total of at most 1) and
// stored as reported, never renormalised, rounded or completed; a label the provider did not report stays absent. A
// refusal is its own outcome. Box is refused locally: there is no reviewed region representation yet. The endpoint's
// effective context is enforced by refusing, never by truncating: the state and questions must fit in its reviewed
// token limit counted as UTF-8 bytes (no tokenizer emits more tokens than bytes), and an unreviewed limit refuses.

export const DECISIONS_PATH = "/api/alpha/decisions"
export const WIRE_REVISION = "openrouter-alpha-decisions-2026-11-11.1"

type Input = z.infer<typeof DecideInput>
type Question = z.infer<typeof QuestionInput>
type Answer = z.infer<typeof DecidedAnswer>

/** The input with its question set resolved and its acceptance profile chosen. */
export interface PreparedDecision extends Input {
  readonly resolvedQuestions: Readonly<Record<string, Question>>
  readonly resolvedSet?: { readonly name: string; readonly digest: string }
  readonly resolvedProfile: ResolvedProfile
}

const changed = (what: string) => new InferenceError("PROVIDER_CONTRACT_CHANGED", `OpenRouter's decision answer does not match the reviewed contract (${WIRE_REVISION}): ${what}.`)
const unsupported = (what: string) => new InferenceError("CAPABILITY_UNSUPPORTED", what)
/** A distribution's total may exceed 1 by float error only; anything more is not a distribution. */
const SUM_TOLERANCE = 1e-9
/** How far a reported expected index may sit from its own complete distribution's mean. */
const MEAN_TOLERANCE = 1e-6

function prepare(raw: unknown, config: Config): PreparedDecision {
  const input = raw as Input
  let questions = input.questions
  let resolvedSet: PreparedDecision["resolvedSet"]
  if (input.questionSet !== undefined) {
    const set = questionSetOf(config, input.questionSet)
    if (!set) throw unsupported(`There is no question set named ${input.questionSet} in the trusted options.`)
    questions = set.questions
    resolvedSet = { name: input.questionSet, digest: questionSetDigest(set) }
  }
  const name = input.acceptanceProfile ?? REVIEW_PROFILE
  const profile = name === REVIEW_PROFILE ? REVIEW_FIRST : acceptanceProfileOf(config, name)
  if (!profile) throw unsupported(`There is no acceptance profile named ${name} in the trusted options.`)
  return { ...input, resolvedQuestions: questions ?? {}, ...(resolvedSet ? { resolvedSet } : {}), resolvedProfile: { name, profile } }
}

function wireQuestion(question: Question): Record<string, unknown> {
  switch (question.type) {
    case "noul":
      return { type: "noul", prompt: question.prompt }
    case "choice":
      return { type: "choice", prompt: question.prompt, options: question.options.map((option) => ({ id: option.id, description: option.description })) }
    case "score":
      return { type: "score", prompt: question.prompt, levels: question.levels.map((level) => ({ id: level.id, description: level.description })) }
    case "box":
      throw unsupported("Box questions are not supported in this version: there is no reviewed image-region representation.")
  }
}

function request(raw: unknown, source: Snapshot, route: RouteCapability) {
  const input = raw as PreparedDecision
  if (source.modality !== "text") throw unsupported(`Decisions in this version take text only, not ${source.mimeType}.`)
  for (const question of Object.values(input.resolvedQuestions))
    if (!route.questionTypes.includes(question.type) || !IMPLEMENTED_QUESTION_TYPES.includes(question.type)) throw unsupported(`${route.model} does not take ${question.type} questions in this version.`)
  const body = {
    model: route.model,
    state: source.text(),
    questions: Object.fromEntries(Object.entries(input.resolvedQuestions).map(([key, question]) => [key, wireQuestion(question)])),
    provider: { allow_fallbacks: false },
  }
  // The effective context, enforced by refusing: an unreviewed limit, or a request that may not fit, sends nothing.
  const prompt = new TextEncoder().encode(JSON.stringify({ state: body.state, questions: body.questions })).byteLength
  if (route.effectiveContextTokens === null)
    throw new InferenceError("CONTEXT_LIMIT", `The effective context of ${route.model} on this endpoint has not been reviewed, so a request could be truncated silently; nothing was sent.`, "Use a route whose effective context is reviewed (see inference_capabilities).")
  if (prompt > route.effectiveContextTokens)
    throw new InferenceError("CONTEXT_LIMIT", `The state and questions (${prompt} bytes) may exceed the ${route.effectiveContextTokens}-token effective context of ${route.model}; the end of the source would not be read.`)
  const bytes = new TextEncoder().encode(JSON.stringify(body))
  if (route.maxRequestBytes !== null && bytes.byteLength > route.maxRequestBytes) throw new InferenceError("CONTEXT_LIMIT", `The request is larger than the ${route.maxRequestBytes} bytes ${route.model} takes.`)
  return { path: DECISIONS_PATH, body: bytes }
}

const quote = (route: RouteCapability, source: Snapshot, input: unknown) => quoteOf(route, () => request(input, source, route).body.byteLength)

// --- Answers ------------------------------------------------------------------------------------------------------------

/** A reported distribution over known labels, exactly as reported. Its total may not exceed 1; it need not reach 1. */
function distributionOf(value: Json | undefined, labels: readonly string[], what: string): Record<string, number> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isObject(value)) throw changed(`${what}.distribution is not an object`)
  const out = new Map<string, number>()
  let total = 0
  for (const [label, probability] of entries(value)) {
    if (!labels.includes(label)) throw changed(`${what}.distribution names a label that was not asked`)
    const p = probabilityOf(probability, `${what}.distribution`, changed)
    if (p === undefined) throw changed(`${what}.distribution has an entry with no probability`)
    out.set(label, p)
    total += p
  }
  if (total > 1 + SUM_TOLERANCE) throw changed(`${what}.distribution totals more than 1`)
  return Object.fromEntries(out)
}

const ANSWER_KEYS = new Set(["probability", "choice", "score", "distribution", "confidence", "refusal", "truncated"])

function answerOf(key: string, question: Question, raw: Json | undefined, warnings: string[]): { answer: Unaccepted; truncated: boolean } {
  const what = `answers.${key}`
  if (!isObject(raw)) throw changed(`${what} is missing or not an object`)
  const answer = entries(raw)
  const unknown = [...answer.keys()].filter((name) => !ANSWER_KEYS.has(name))
  if (unknown.length > 8) throw changed(`${what} has too many unknown keys`)
  if (unknown.length) warnings.push(`${what}: ${unknown.length} unknown key(s) ignored`)
  const truncatedRaw = answer.get("truncated")
  if (truncatedRaw !== undefined && truncatedRaw !== null && typeof truncatedRaw !== "boolean") throw changed(`${what}.truncated is not a boolean`)
  const truncated = truncatedRaw === true
  const confidence = probabilityOf(answer.get("confidence"), `${what}.confidence`, changed)
  const refusalRaw = answer.get("refusal")
  if (refusalRaw !== undefined && refusalRaw !== null) {
    if (typeof refusalRaw !== "string" || refusalRaw.length > 1000) throw changed(`${what}.refusal is not a short reason`)
    // A refusal carries no answer: one with a value is ambiguous, not a refusal.
    if (["probability", "choice", "score", "distribution"].some((name) => answer.get(name) !== undefined && answer.get(name) !== null)) throw changed(`${what} both refuses and answers`)
    const refusal = refusalRaw ? { reason: refusalRaw } : {}
    const extra = confidence !== undefined ? { confidence } : {}
    if (question.type === "score") return { truncated, answer: { type: "score", levels: question.levels.map((level) => level.id), refusal, ...extra } }
    if (question.type === "choice") return { truncated, answer: { type: "choice", refusal, ...extra } }
    if (question.type === "noul") return { truncated, answer: { type: "noul", refusal, ...extra } }
    throw unsupported("Box questions are not supported in this version.")
  }
  switch (question.type) {
    case "noul": {
      const probability = probabilityOf(answer.get("probability"), `${what}.probability`, changed)
      if (probability === undefined) throw changed(`${what} has no probability`)
      return { truncated, answer: { type: "noul", probability, ...(confidence !== undefined ? { confidence } : {}) } }
    }
    case "choice": {
      const labels = question.options.map((option) => option.id)
      const choice = answer.get("choice")
      if (typeof choice !== "string" || !labels.includes(choice)) throw changed(`${what}.choice is not one of the options`)
      const distribution = distributionOf(answer.get("distribution"), labels, what)
      return { truncated, answer: { type: "choice", choice, ...(distribution ? { distribution } : {}), ...(confidence !== undefined ? { confidence } : {}) } }
    }
    case "score": {
      const levels = question.levels.map((level) => level.id)
      const score = answer.get("score")
      if (!(score instanceof JsonNumber) || !Number.isFinite(score.value) || score.value < 0 || score.value > levels.length - 1) throw changed(`${what}.score is not a position on the rubric`)
      const distribution = distributionOf(answer.get("distribution"), levels, what)
      // A complete distribution must agree with its own expected index; it is checked, never adjusted.
      if (distribution && Object.keys(distribution).length === levels.length) {
        const total = Object.values(distribution).reduce((sum, p) => sum + p, 0)
        const mean = levels.reduce((sum, level, index) => sum + index * (new Map(Object.entries(distribution)).get(level) ?? 0), 0)
        if (Math.abs(total - 1) <= MEAN_TOLERANCE && Math.abs(mean - score.value) > MEAN_TOLERANCE) throw changed(`${what}.score disagrees with its distribution`)
      }
      return { truncated, answer: { type: "score", expectedIndex: score.value, levels, ...(distribution ? { distribution } : {}), ...(confidence !== undefined ? { confidence } : {}) } }
    }
    case "box":
      throw unsupported("Box questions are not supported in this version.")
  }
}

const TOP_KEYS = new Set(["id", "model", "answers", "usage", "truncated", "object", "created"])

function parse(response: TransportResponse, context: { readonly source: Snapshot; readonly route: RouteCapability; readonly input: unknown }): AdapterResult {
  const input = context.input as PreparedDecision
  const { route } = context
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
  if (unknown.length > 32) throw changed("too many unknown top-level keys")
  if (unknown.length) warnings.push(`${unknown.length} unknown response key(s) ignored`)
  const model = top.get("model")
  if (model !== undefined && model !== route.model) throw changed("the answer came from another model")
  const id = top.get("id")
  if (id !== undefined && (typeof id !== "string" || !REQUEST_ID.test(id))) throw changed("id is not a request id")
  const truncatedTop = top.get("truncated")
  if (truncatedTop !== undefined && truncatedTop !== null && typeof truncatedTop !== "boolean") throw changed("truncated is not a boolean")
  const answers = top.get("answers")
  if (!isObject(answers)) throw changed("answers is missing or not an object")
  const answerMap = entries(answers)
  const asked = new Map(Object.entries(input.resolvedQuestions))
  if ([...answerMap.keys()].some((key) => !asked.has(key))) throw changed("answers has keys that were not asked")

  const parsed = [...asked].map(([key, question]) => ({ key, question, ...answerOf(key, question, answerMap.get(key), warnings) }))
  const truncated = truncatedTop === true || parsed.some((item) => item.truncated)
  const out = new Map<string, Answer>()
  for (const { key, question, answer } of parsed) {
    const acceptance = accept(answer, question, input.resolvedProfile, { model: route.model, ...(input.resolvedSet ? { questionSet: input.resolvedSet } : {}), truncated })
    out.set(key, { ...answer, acceptance } as Answer)
  }
  const reasons = new Set<string>()
  for (const answer of out.values()) for (const reason of answer.acceptance.reasons) reasons.add(reason)
  const required = [...out.values()].some((answer) => answer.acceptance.disposition !== "accepted")
  return {
    data: {
      answers: Object.fromEntries(out),
      ...(input.resolvedSet ? { questionSet: input.resolvedSet } : {}),
      acceptanceProfile: { name: input.resolvedProfile.name, mode: input.resolvedProfile.profile.mode },
    },
    usage: usageOf(top.get("usage"), changed),
    coverage: { status: truncated ? "partial" : "complete", basis: "provided-text", sourceTruncated: false, providerTruncated: truncated, warnings: warnings.slice(0, 32) },
    review: { required, reasons: [...reasons].sort().slice(0, 64), profileVersion: input.resolvedProfile.name },
    ...(typeof id === "string" ? { providerRequestId: id } : {}),
  }
}

/** The adapter the dispatcher runs for `decide`. */
export const decisionsAdapter: Adapter = { operation: "decide", revision: WIRE_REVISION, prepare, quote, request, parse }
