// The OpenRouter Decisions adapter against sanitized fixtures: the wire request, question sets, Box and effective
// context refused locally, probabilities and distributions kept exactly as reported, per-question refusal, and
// deterministic acceptance.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { questionSetDigest, type HeldOutReport, type QuestionSet } from "../../src/domain/acceptance.js"
import { loadConfig, type Options } from "../../src/domain/config.js"
import { DecideData, DecideInput } from "../../src/domain/contracts.js"
import { OPENROUTER_CAPABILITIES, type RouteCapability } from "../../src/providers/openrouter/capabilities.js"
import { DECISIONS_PATH, decisionsAdapter, WIRE_REVISION, type PreparedDecision } from "../../src/providers/openrouter/decisions.js"
import { snapshot, type FileAccess, type Snapshot } from "../../src/runtime/sources.js"

const STATE = "Payment received for invoice AB-72. Thank you."
const FIXTURE = readFileSync(new URL("../fixtures/providers/openrouter-decisions/jev-text.json", import.meta.url), "utf8")
const JEV: RouteCapability = { ...OPENROUTER_CAPABILITIES.routes.find((route) => route.model === "typesafe/jev-1.14")!, effectiveContextTokens: 4096, contextAllowance: { tokens: 512, source: "test" } }
const QUESTIONS = {
  kind: { type: "choice", prompt: "Which document category fits?", options: [{ id: "invoice", description: "A request for payment" }, { id: "receipt", description: "Proof of payment" }, { id: "other", description: "Other" }] },
  paid: { type: "noul", prompt: "Has it been paid?" },
  urgency: { type: "score", prompt: "How urgent?", levels: [{ id: "low", description: "low" }, { id: "mid", description: "mid" }, { id: "high", description: "high" }] },
  language: { type: "choice", prompt: "Which language?", options: [{ id: "en", description: "English" }, { id: "de", description: "German" }] },
} as const
const SET: QuestionSet = { questions: QUESTIONS as unknown as QuestionSet["questions"] }
/** QUESTIONS as D1 documents them: what the request must carry. */
const WIRE_QUESTIONS = {
  kind: { type: "choice", instructions: "Which document category fits?", criteria: { invoice: "A request for payment", receipt: "Proof of payment", other: "Other" } },
  paid: { type: "noul", instructions: "Has it been paid?" },
  urgency: { type: "score", instructions: "How urgent?", criteria: ["low", "mid", "high"] },
  language: { type: "choice", instructions: "Which language?", criteria: { en: "English", de: "German" } },
}
const noFiles = {} as FileAccess
const text = (value = STATE) => snapshot({ kind: "text", text: value }, noFiles, JEV, new AbortController().signal)
const prepared = (input: Record<string, unknown>, options: Options = {}) => decisionsAdapter.prepare!(DecideInput.parse({ model: "typesafe/jev-1.14", source: { kind: "text", text: STATE }, ...input }), loadConfig(options)) as PreparedDecision
const answer = (body: string) => ({ status: 200, contentType: "application/json", body: new TextEncoder().encode(body), elapsedMs: 5 })
const parse = async (body: string, input = prepared({ questions: QUESTIONS }), source?: Snapshot) => decisionsAdapter.parse(answer(body), { source: source ?? (await text()), route: JEV, input })
const withAnswers = (answers: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ model: "typesafe/jev-1.14", answers, ...extra })
const failure = async (work: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof work === "function" ? work() : work)
  } catch (error) {
    return (error as Error).message
  }
  return "no failure"
}

describe("the request", () => {
  test("is the documented wire shape (D1): instructions, a choice's criteria by option id, a score's criteria in order; a question set is resolved", async () => {
    const built = decisionsAdapter.request(prepared({ questions: QUESTIONS }), await text(), JEV)
    expect(built.path).toBe(DECISIONS_PATH)
    const body = JSON.parse(new TextDecoder().decode(built.body))
    expect(body).toEqual({ model: "typesafe/jev-1.14", state: STATE, questions: WIRE_QUESTIONS, provider: { allow_fallbacks: false } })
    const fromSet = prepared({ questionSet: "document-kind-v1" }, { questionSets: { "document-kind-v1": SET } })
    expect(fromSet.resolvedSet).toEqual({ name: "document-kind-v1", digest: questionSetDigest(SET) })
    expect(JSON.parse(new TextDecoder().decode(decisionsAdapter.request(fromSet, await text(), JEV).body)).questions).toEqual(WIRE_QUESTIONS)
  })

  test("unknown sets and profiles, Box, images, and an unreviewed or exceeded effective context are refused locally", async () => {
    expect(await failure(() => prepared({ questionSet: "document-kind-v9" }))).toMatch(/^CAPABILITY_UNSUPPORTED: There is no question set named document-kind-v9/)
    expect(await failure(() => prepared({ questions: QUESTIONS, acceptanceProfile: "missing-v1" }))).toMatch(/^CAPABILITY_UNSUPPORTED: There is no acceptance profile named missing-v1/)
    const source = await text()
    expect(await failure(() => decisionsAdapter.request(prepared({ questions: { region: { type: "box", prompt: "Where?" } } }), source, JEV))).toMatch(/^CAPABILITY_UNSUPPORTED: /)
    const image: Snapshot = { ...source, modality: "image", mimeType: "image/png" }
    expect(await failure(() => decisionsAdapter.request(prepared({ questions: QUESTIONS }), image, JEV))).toMatch(/^CAPABILITY_UNSUPPORTED: Decisions in this version take text only/)
    expect(await failure(() => decisionsAdapter.request(prepared({ questions: QUESTIONS }), source, { ...JEV, effectiveContextTokens: null }))).toMatch(/^CONTEXT_LIMIT: The effective context of typesafe\/jev-1.14 on this endpoint has not been reviewed/)
    // Decisive information at the end of a long source is never cut off silently: the request is refused instead.
    const long = await snapshot({ kind: "text", text: `${"filler ".repeat(1000)}DECISIVE: paid in full.` }, noFiles, JEV, new AbortController().signal)
    expect(await failure(() => decisionsAdapter.request(prepared({ questions: QUESTIONS }), long, JEV))).toMatch(/^CONTEXT_LIMIT: .*may exceed the 3584 tokens left of the 4096-token effective context/)
  })

  test("a reviewed limit is usable only net of a documented template allowance", async () => {
    const source = await text()
    // A limit without its allowance refuses: a server-side template could push the request past it.
    expect(await failure(() => decisionsAdapter.request(prepared({ questions: QUESTIONS }), source, { ...JEV, contextAllowance: null }))).toMatch(/^CONTEXT_LIMIT: typesafe\/jev-1.14 has no documented template allowance/)
    const prompt = new TextEncoder().encode(JSON.stringify({ state: STATE, questions: WIRE_QUESTIONS })).byteLength
    // Fits exactly the limit net of the allowance; one token more of allowance and it does not.
    expect(() => decisionsAdapter.request(prepared({ questions: QUESTIONS }), source, { ...JEV, effectiveContextTokens: prompt + 100, contextAllowance: { tokens: 100, source: "test" } })).not.toThrow()
    expect(await failure(() => decisionsAdapter.request(prepared({ questions: QUESTIONS }), source, { ...JEV, effectiveContextTokens: prompt + 100, contextAllowance: { tokens: 101, source: "test" } }))).toMatch(/^CONTEXT_LIMIT: /)
    expect(await failure(() => decisionsAdapter.request(prepared({ questions: QUESTIONS }), source, { ...JEV, effectiveContextTokens: 100, contextAllowance: { tokens: 100, source: "test" } }))).toMatch(/^CONTEXT_LIMIT: /)
  })
})

describe("the answer", () => {
  test("keeps probabilities and distributions exactly as reported, confidence apart, and refusal as its own outcome", async () => {
    const result = await parse(FIXTURE)
    expect(DecideData.safeParse(result.data).success).toBe(true)
    const answers = (result.data as { answers: Record<string, any> }).answers
    // 0.7 + 0.2: "other" was not reported, so it is absent, not 0, and nothing is renormalised to total 1.
    expect(answers.kind).toMatchObject({ type: "choice", choice: "invoice", distribution: { invoice: "0.7", receipt: "0.2" }, confidence: "0.81" })
    expect(Object.keys(answers.kind.distribution)).toEqual(["invoice", "receipt"])
    expect(answers.paid).toMatchObject({ type: "noul", probability: "0.12" })
    expect(answers.paid.confidence).toBeUndefined()
    // A midpoint expectation with all its mass at the extremes keeps its distribution.
    expect(answers.urgency).toMatchObject({ type: "score", expectedIndex: "1", levels: ["low", "mid", "high"], distribution: { low: "0.5", mid: "0", high: "0.5" } })
    // A refusal is `{ type: "refusal" }` (D1): its own outcome, with no reason because none is reported.
    expect(answers.language).toEqual({ type: "choice", refusal: {}, acceptance: { disposition: "refused", reasons: ["REFUSED"] } })
    // review-first-v1 accepts nothing.
    for (const key of ["kind", "paid", "urgency"]) expect(answers[key].acceptance).toEqual({ disposition: "review", reasons: ["CALIBRATION_UNAVAILABLE"] })
    expect(result.review).toEqual({ required: true, reasons: ["CALIBRATION_UNAVAILABLE", "REFUSED"], profileVersion: "review-first-v1" })
    expect(result.usage).toEqual({ charges: [{ party: "platform", currency: "USD", amount: "0.000042000001", basis: "reported" }], inputTokens: 80, outputTokens: 12, costStatus: "known" })
    expect(result.coverage).toEqual({ status: "complete", basis: "provided-text", sourceTruncated: false, providerTruncated: false, warnings: [] })
    expect(result.providerRequestId).toBe("gen-decide-fixture-0001")
  })

  test("an evaluated automatic profile accepts what passes its thresholds, and only on its own model and question set", async () => {
    const report: HeldOutReport = {
      schemaVersion: 1,
      profile: "document-kind-auto-v1",
      model: "typesafe/jev-1.14",
      questionSet: "document-kind-v1",
      questionSetDigest: questionSetDigest(SET),
      adapterRevision: WIRE_REVISION,
      thresholds: { noul: { accept: 0.85 } },
      dataset: { revision: "r1", sha256: "b".repeat(64), tuning: 100, heldOut: 50 },
      heldOut: { answers: 200, accepted: 120, falseAccepts: 1, reviewed: 70, refused: 10 },
      createdAt: "2026-11-12T00:00:00Z",
    }
    const options: Options = {
      questionSets: { "document-kind-v1": SET },
      acceptanceProfiles: { "document-kind-auto-v1": { mode: "automatic", model: "typesafe/jev-1.14", questionSet: "document-kind-v1", rules: { noul: { accept: 0.85 } }, maxFalseAcceptRate: "0.02", report } },
    }
    const input = prepared({ questionSet: "document-kind-v1", acceptanceProfile: "document-kind-auto-v1" }, options)
    const answers = (await parse(FIXTURE, input)).data as { answers: Record<string, any> }
    // 0.12 is at most 1 - 0.85: accepted as false. Choice and score have no rule: reviewed.
    expect(answers.answers.paid.acceptance).toEqual({ disposition: "accepted", outcome: false, reasons: [] })
    expect(answers.answers.kind.acceptance.disposition).toBe("review")
    // A truncated state is never accepted.
    const truncated = (await parse(FIXTURE.replace('"provider": "TypeSafe",', '"provider": "TypeSafe", "truncated": true,'), input)).data as { answers: Record<string, any> }
    expect(truncated.answers.paid.acceptance).toEqual({ disposition: "review", reasons: ["PROVIDER_TRUNCATED"] })
    // Ad-hoc questions are not the evaluated set: reviewed.
    const adhoc = prepared({ questions: QUESTIONS, acceptanceProfile: "document-kind-auto-v1" }, options)
    expect(((await parse(FIXTURE, adhoc)).data as { answers: Record<string, any> }).answers.paid.acceptance.reasons).toEqual(["CALIBRATION_MISMATCH"])
  })

  test("anything that would need renormalising, rounding or guessing is a contract failure", async () => {
    const answers = JSON.parse(FIXTURE).answers
    const bad: [string, string][] = [
      ["probabilities over 1", withAnswers({ ...answers, kind: { type: "choice", choice: "invoice", probabilities: { invoice: 0.8, receipt: 0.3 } } })],
      ["unknown label", withAnswers({ ...answers, kind: { type: "choice", choice: "invoice", probabilities: { invoice: 0.5, spam: 0.5 } } })],
      ["choice not an option", withAnswers({ ...answers, kind: { type: "choice", choice: "spam" } })],
      ["noul over 1", withAnswers({ ...answers, paid: { type: "noul", noul: 1.2 } })],
      ["noul missing", withAnswers({ ...answers, paid: { type: "noul", confidence: 0.9 } })],
      ["no type", withAnswers({ ...answers, paid: { noul: 0.5 } })],
      ["another type", withAnswers({ ...answers, paid: { type: "choice", choice: "yes" } })],
      ["score past the rubric", withAnswers({ ...answers, urgency: { type: "score", score: 2.5 } })],
      ["score level past the rubric", withAnswers({ ...answers, urgency: { type: "score", score: 1, probabilities: { "3": 0.1 } } })],
      ["score level by id, not index", withAnswers({ ...answers, urgency: { type: "score", score: 1, probabilities: { mid: 1 } } })],
      ["score off its own distribution", withAnswers({ ...answers, urgency: { type: "score", score: 0.2, probabilities: { "0": 0.5, "1": 0, "2": 0.5 } } })],
      ["refusal with an answer", withAnswers({ ...answers, paid: { type: "refusal", noul: 0.5 } })],
      ["legend not an object", withAnswers({ ...answers, urgency: { type: "score", score: 1, legend: ["low"] } })],
      ["annotations not a list", withAnswers(answers, { annotations: {} })],
      ["missing answer", withAnswers({ ...answers, paid: undefined })],
      ["extra answer", withAnswers({ ...answers, extra: { type: "noul", noul: 0.5 } })],
      ["another model", JSON.stringify({ model: "typesafe/jev-2", answers })],
      ["negative cost", withAnswers(answers, { usage: { cost: -1 } })],
    ]
    for (const [name, body] of bad) expect({ name, message: (await failure(parse(body))).slice(0, 26) }).toEqual({ name, message: "PROVIDER_CONTRACT_CHANGED:" })
    // An incomplete score distribution is kept, not completed.
    const partial = (await parse(withAnswers({ ...answers, urgency: { type: "score", score: 0.4, probabilities: { "0": 0.6 } } }))).data as { answers: Record<string, any> }
    expect(partial.answers.urgency.distribution).toEqual({ low: "0.6" })
  })

  test("the documented example answer (D1) is accepted, with its canonical slug, provider and score legend", async () => {
    // The response example in OpenRouter's API reference, with this test's question keys.
    const example = JSON.stringify({
      answers: {
        paid: { noul: 0.96, type: "noul" },
        kind: { choice: "receipt", confidence: 0.75, probabilities: { invoice: 0, other: 0.16, receipt: 0.84 }, type: "choice" },
        urgency: { confidence: 0.99, legend: { "0": "low", "1": "mid", "2": "high" }, probabilities: { "0": 0, "1": 0.01, "2": 0.99 }, score: 1.99, type: "score" },
        language: { type: "refusal" },
      },
      id: "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
      model: "typesafe/jev-1.14-20261014",
      provider: "TypeSafe",
      usage: { cost: 0.000019992, input_tokens: 476, output_tokens: 70 },
    })
    const result = await parse(example)
    const answers = (result.data as { answers: Record<string, any> }).answers
    expect(answers.paid).toMatchObject({ type: "noul", probability: "0.96" })
    expect(answers.kind).toMatchObject({ type: "choice", choice: "receipt", distribution: { invoice: "0", other: "0.16", receipt: "0.84" }, confidence: "0.75" })
    expect(answers.urgency).toMatchObject({ type: "score", expectedIndex: "1.99", levels: ["low", "mid", "high"], distribution: { low: "0", mid: "0.01", high: "0.99" } })
    expect(result.usage).toEqual({ charges: [{ party: "platform", currency: "USD", amount: "0.000019992", basis: "reported" }], inputTokens: 476, outputTokens: 70, costStatus: "known" })
    expect(result.coverage.warnings).toEqual([])
  })

  test("probabilities are the provider's exact decimals, never binary floats", async () => {
    const answers = JSON.parse(FIXTURE).answers
    const body = withAnswers({ ...answers, paid: { type: "noul", noul: "__P__" }, kind: { type: "choice", choice: "invoice", probabilities: { invoice: "__D__" } } })
      .replace('"__P__"', "0.1000000000000000055511151231257827")
      .replace('"__D__"', "1.5e-7")
    const exact = (await parse(body)).data as { answers: Record<string, any> }
    // A double would read the first as 0.1 and print the second as 1.5e-7.
    expect(exact.answers.paid.probability).toBe("0.1000000000000000055511151231257827")
    expect(exact.answers.kind.distribution).toEqual({ invoice: "0.00000015" })
    expect(String(0.1000000000000000055511151231257827)).toBe("0.1")
    // Past 64 fractional digits is refused, never rounded.
    expect((await failure(parse(withAnswers({ ...answers, paid: { type: "noul", noul: "__P__" } }).replace('"__P__"', `0.${"1".repeat(65)}`)))).slice(0, 26)).toBe("PROVIDER_CONTRACT_CHANGED:")
  })
})

describe("through the dispatcher, with the fake transport", () => {
  test("a decision settles the exact reported charge, on both surfaces; an unknown question set sends nothing", async () => {
    const { probeHarness, probeRoute } = await import("../support/operation-kit.js")
    const { DecideResult } = await import("../../src/domain/contracts.js")
    const route = probeRoute({ ...JEV, enabled: true, canary: { status: "passed", on: "2026-11-12" }, pricing: { revision: "test", currency: "USD", perRequest: "0.002", upperBound: true } })
    const tool = { name: "decide", class: "send" as const, operation: "decide" as const, module: "decisions" as const, effects: { network: true, uploadsSource: true, billable: true, readsFiles: true }, description: "decide", input: DecideInput, output: DecideResult }
    const harness = await probeHarness({ route, tool, adapter: decisionsAdapter, options: { profiles: { probe: { model: "typesafe/jev-1.14" } } } })
    harness.replies.push(answer(FIXTURE), answer(FIXTURE))
    const request = { profile: "probe", source: { kind: "text", text: STATE }, questions: QUESTIONS }
    const model = (await harness.model(request)) as { output: any }
    const script = (await harness.rpc(request)) as any
    expect(DecideResult.safeParse(model.output).success).toBe(true)
    expect(script.data).toEqual(model.output.data)
    expect((await harness.journal.list()).map((record) => [record.reservation.amount, record.reservation.basis, record.charges[0]?.amount])).toEqual([
      ["0.002", "upper_bound", "0.000042000001"],
      ["0.002", "upper_bound", "0.000042000001"],
    ])
    const unknown = (await harness.rpc({ profile: "probe", source: { kind: "text", text: STATE }, questionSet: "nothing-v1" })) as { error: { data: { code: string } } }
    expect(unknown.error.data.code).toBe("CAPABILITY_UNSUPPORTED")
    expect(harness.sent).toHaveLength(2)
  })
})
