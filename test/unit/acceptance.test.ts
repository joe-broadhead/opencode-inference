// Deterministic acceptance: versioned profiles, the held-out report an automatic profile needs, and the exact use of
// reported probabilities (never renormalised, rounded or completed; confidence never counted).
import { describe, expect, test } from "bun:test"
import { accept, automaticProblem, questionSetDigest, REVIEW_FIRST, type AcceptanceProfile, type HeldOutReport, type QuestionSet } from "../../src/domain/acceptance.js"
import { loadConfig } from "../../src/domain/config.js"

const KIND: QuestionSet = {
  questions: {
    kind: { type: "choice", prompt: "Which document category fits?", options: [{ id: "invoice", description: "A request for payment" }, { id: "receipt", description: "Proof of payment" }, { id: "other", description: "Other or insufficient evidence" }] },
    paid: { type: "noul", prompt: "Has the invoice been paid?" },
    urgency: { type: "score", prompt: "How urgent is it?", levels: [{ id: "low", description: "low" }, { id: "mid", description: "mid" }, { id: "high", description: "high" }] },
  },
}
const RULES = { noul: { accept: 0.9 }, choice: { minProbability: 0.8, minMargin: 0.3 }, score: { minProbability: 0.7 } }
const report = (overrides: Partial<HeldOutReport> = {}): HeldOutReport => ({
  schemaVersion: 1,
  profile: "document-kind-auto-v1",
  model: "typesafe/jev-1.14",
  questionSet: "document-kind-v1",
  questionSetDigest: questionSetDigest(KIND),
  thresholds: RULES,
  dataset: { revision: "docs-2026-11", sha256: "a".repeat(64), tuning: 120, heldOut: 60 },
  heldOut: { answers: 180, accepted: 100, falseAccepts: 1, reviewed: 75, refused: 5 },
  createdAt: "2026-11-12T00:00:00Z",
  ...overrides,
})
const automatic = (overrides: Partial<AcceptanceProfile> = {}): AcceptanceProfile => ({ mode: "automatic", model: "typesafe/jev-1.14", questionSet: "document-kind-v1", rules: RULES, maxFalseAcceptRate: "0.02", report: report(), ...overrides })
const AUTO = { name: "document-kind-auto-v1", profile: automatic() }
const CONTEXT = { model: "typesafe/jev-1.14", questionSet: { name: "document-kind-v1", digest: questionSetDigest(KIND) }, truncated: false }
const q = KIND.questions

describe("an automatic profile must be backed by a matching held-out report", () => {
  const options = (profile: AcceptanceProfile) => ({ questionSets: { "document-kind-v1": KIND }, acceptanceProfiles: { "document-kind-auto-v1": profile } })
  test("a matching report loads", () => {
    expect(automaticProblem("document-kind-auto-v1", automatic(), { "document-kind-v1": KIND })).toBeUndefined()
    expect(loadConfig(options(automatic())).acceptanceProfiles["document-kind-auto-v1"]!.mode).toBe("automatic")
  })
  test("anything that breaks the link between thresholds and held-out evidence is refused at load", () => {
    const bad: [string, AcceptanceProfile][] = [
      ["no report", automatic({ report: undefined })],
      ["another model", automatic({ model: "typesafe/jev-2" })],
      ["a changed question set", automatic({ report: report({ questionSetDigest: `sha256:${"0".repeat(64)}` }) })],
      ["other thresholds", automatic({ rules: { ...RULES, noul: { accept: 0.8 } } })],
      ["too few held-out cases", automatic({ report: report({ dataset: { revision: "r", sha256: "a".repeat(64), tuning: 10, heldOut: 20 } }) })],
      ["a false-accept rate above the maximum", automatic({ maxFalseAcceptRate: "0.005" })],
      ["counts that do not add up", automatic({ report: report({ heldOut: { answers: 10, accepted: 100, falseAccepts: 1, reviewed: 0, refused: 0 } }) })],
      ["nothing accepted", automatic({ report: report({ heldOut: { answers: 180, accepted: 0, falseAccepts: 0, reviewed: 175, refused: 5 } }) })],
    ]
    for (const [name, profile] of bad) expect({ name, loads: (() => { try { loadConfig(options(profile)); return true } catch (error) { return (error as Error).message.startsWith("OPTIONS_INVALID: ") ? false : String(error) } })() }).toEqual({ name, loads: false })
    // 1 false accept in 100 is 0.01: exactly at a maximum of 0.01 is allowed, in exact arithmetic.
    expect(automaticProblem("document-kind-auto-v1", automatic({ maxFalseAcceptRate: "0.01" }), { "document-kind-v1": KIND })).toBeUndefined()
    expect(() => loadConfig({ acceptanceProfiles: { "review-first-v1": { mode: "review" } } })).toThrow(/OPTIONS_INVALID/)
    // A review profile needs no report: it accepts nothing.
    expect(loadConfig({ acceptanceProfiles: { "careful-v1": { mode: "review" } } }).acceptanceProfiles["careful-v1"]!.mode).toBe("review")
  })
})

describe("acceptance uses reported probabilities exactly", () => {
  test("review-first-v1 and review profiles accept nothing; a refusal is refused, not false", () => {
    expect(accept({ type: "noul", probability: "0.999" }, q.paid!, { name: "review-first-v1", profile: REVIEW_FIRST }, CONTEXT)).toEqual({ disposition: "review", reasons: ["CALIBRATION_UNAVAILABLE"] })
    expect(accept({ type: "noul", refusal: {} }, q.paid!, AUTO, CONTEXT)).toEqual({ disposition: "refused", reasons: ["REFUSED"] })
  })

  test("noul: true above the threshold, false below its complement, review between or without a probability", () => {
    expect(accept({ type: "noul", probability: "0.95" }, q.paid!, AUTO, CONTEXT)).toEqual({ disposition: "accepted", outcome: true, reasons: [] })
    expect(accept({ type: "noul", probability: "0.05" }, q.paid!, AUTO, CONTEXT)).toEqual({ disposition: "accepted", outcome: false, reasons: [] })
    expect(accept({ type: "noul", probability: "0.5" }, q.paid!, AUTO, CONTEXT)).toEqual({ disposition: "review", reasons: ["LOW_PROBABILITY"] })
    // A reported confidence is never a probability: it cannot pass the threshold.
    expect(accept({ type: "noul", confidence: "0.99" }, q.paid!, AUTO, CONTEXT)).toEqual({ disposition: "review", reasons: ["CONFIDENCE_MISSING"] })
  })

  test("choice: a distribution is required, never renormalised, and confidence is not counted again", () => {
    expect(accept({ type: "choice", choice: "invoice", distribution: { invoice: "0.9", receipt: "0.05", other: "0.05" } }, q.kind!, AUTO, CONTEXT)).toMatchObject({ disposition: "accepted", outcome: "invoice" })
    expect(accept({ type: "choice", choice: "invoice", confidence: "0.99" }, q.kind!, AUTO, CONTEXT).reasons).toEqual(["CONFIDENCE_MISSING"])
    // 0.75 reported for the only label given: renormalising would make it 1.0 and accept it. It is reviewed.
    expect(accept({ type: "choice", choice: "invoice", distribution: { invoice: "0.75" } }, q.kind!, AUTO, CONTEXT).reasons).toEqual(["LOW_PROBABILITY"])
    expect(accept({ type: "choice", choice: "invoice", distribution: { invoice: "0.82", receipt: "0.18" } }, q.kind!, AUTO, CONTEXT)).toMatchObject({ disposition: "accepted" })
    expect(accept({ type: "choice", choice: "invoice", distribution: { invoice: "0.81", receipt: "0.6" } }, q.kind!, AUTO, CONTEXT).reasons).toEqual(["AMBIGUOUS"])
    expect(accept({ type: "choice", choice: "receipt", distribution: { invoice: "0.9", receipt: "0.1" } }, q.kind!, AUTO, CONTEXT).reasons).toEqual(["INCONSISTENT"])
    // High or low confidence changes nothing: it is derived from the same distribution.
    const base = { type: "choice" as const, choice: "invoice", distribution: { invoice: "0.9", receipt: "0.1" } }
    expect(accept({ ...base, confidence: "0.01" }, q.kind!, AUTO, CONTEXT)).toEqual(accept({ ...base, confidence: "0.99" }, q.kind!, AUTO, CONTEXT))
  })

  test("score: a midpoint expectation over opposite extremes is not certainty", () => {
    expect(accept({ type: "score", expectedIndex: "1", levels: ["low", "mid", "high"], distribution: { low: "0.5", high: "0.5" } }, q.urgency!, AUTO, CONTEXT).reasons).toEqual(["LOW_PROBABILITY"])
    expect(accept({ type: "score", expectedIndex: "1", levels: ["low", "mid", "high"], distribution: { low: "0.1", mid: "0.85", high: "0.05" } }, q.urgency!, AUTO, CONTEXT)).toEqual({ disposition: "accepted", outcome: "mid", reasons: [] })
    expect(accept({ type: "score", expectedIndex: "1", levels: ["low", "mid", "high"] }, q.urgency!, AUTO, CONTEXT).reasons).toEqual(["CONFIDENCE_MISSING"])
  })

  test("a different model, question set or truncated state turns acceptance back into review", () => {
    const answer = { type: "noul" as const, probability: "0.99" }
    expect(accept(answer, q.paid!, AUTO, { ...CONTEXT, model: "typesafe/jev-2" }).reasons).toEqual(["CALIBRATION_MISMATCH"])
    expect(accept(answer, q.paid!, AUTO, { ...CONTEXT, questionSet: { name: "document-kind-v1", digest: `sha256:${"1".repeat(64)}` } }).reasons).toEqual(["CALIBRATION_MISMATCH"])
    expect(accept(answer, q.paid!, AUTO, { model: CONTEXT.model, truncated: false }).reasons).toEqual(["CALIBRATION_MISMATCH"])
    expect(accept(answer, q.paid!, AUTO, { ...CONTEXT, truncated: true }).reasons).toEqual(["PROVIDER_TRUNCATED"])
  })

  test("labels carry no authority: renaming the options changes nothing but the label", () => {
    const named = (ids: [string, string]) =>
      accept({ type: "choice", choice: ids[0], distribution: { [ids[0]]: "0.9", [ids[1]]: "0.1" } }, { type: "choice", prompt: "p", options: ids.map((id) => ({ id, description: id })) }, AUTO, CONTEXT)
    expect(named(["approve_payment", "deny"])).toEqual({ disposition: "accepted", outcome: "approve_payment", reasons: [] })
    expect(named(["blue", "green"])).toEqual({ disposition: "accepted", outcome: "blue", reasons: [] })
  })
})
