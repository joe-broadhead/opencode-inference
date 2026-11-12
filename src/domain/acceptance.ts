import { createHash } from "node:crypto"
import * as z from "zod"
import { ACCEPTANCE_REASONS, Decimal, Key, ModelId, QuestionInput, VersionedName, type Acceptance, type DecidedAnswer } from "./contracts.js"
import { money } from "./money.js"
import { canonical } from "./canonical.js"

// Acceptance (handoff §7.2, §8.3, §15.3, §16.3). A provider's probability is a reported model statistic, not verified
// correctness; whether an answer is ACCEPTED is decided here, in ordinary deterministic code, by a versioned profile:
//
// - `review-first-v1` (built in, uncalibrated) and any `mode: "review"` profile accept nothing: every answer is
//   returned for review, with the reasons that apply.
// - A `mode: "automatic"` profile accepts an answer only when its thresholds are met, and only if it carries a held-out
//   report for the same profile, model, question set (by digest) and thresholds, measured on held-out data with an
//   acceptable false-accept rate. The options are refused otherwise. At run time, a different model or question set
//   than the report's turns every answer back to review (CALIBRATION_MISMATCH): changing either invalidates calibration.
// - Thresholds use only the reported probability or distribution, exactly as reported: never renormalised, rounded or
//   completed. A missing probability cannot pass a probability threshold. The reported confidence is never used: it is
//   derived from the distribution, so counting it again would double-count the same evidence.
// - A refusal is `refused`: not false, not zero, not review.
// - An accepted outcome is a label. Nothing here, or anywhere in the plugin, treats a label as a permission.

const probability = z.number().finite().min(0).max(1)

export const AcceptanceRules = z
  .strictObject({
    noul: z.strictObject({ accept: probability.min(0.5).describe("Accept true at a probability of at least this, false at most 1 minus this; review between.") }).optional(),
    choice: z
      .strictObject({
        minProbability: probability.describe("The top option's reported probability must reach this."),
        minMargin: probability.optional().describe("And lead the second by at least this."),
      })
      .optional(),
    score: z.strictObject({ minProbability: probability.describe("The most probable level's reported probability must reach this.") }).optional(),
  })
  .describe("Thresholds per question type. A type without a rule is always reviewed.")

/** The minimum held-out sample an automatic profile may rest on. A floor, not a guarantee of adequacy. */
export const MIN_HELD_OUT = 30

export const HeldOutReport = z
  .strictObject({
    schemaVersion: z.literal(1),
    profile: VersionedName,
    model: ModelId,
    questionSet: VersionedName,
    questionSetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    thresholds: AcceptanceRules,
    dataset: z.strictObject({ revision: z.string().min(1).max(128), sha256: z.string().regex(/^[0-9a-f]{64}$/), tuning: z.number().int().nonnegative(), heldOut: z.number().int().min(1) }),
    heldOut: z.strictObject({
      answers: z.number().int().nonnegative(),
      accepted: z.number().int().nonnegative(),
      falseAccepts: z.number().int().nonnegative(),
      reviewed: z.number().int().nonnegative(),
      refused: z.number().int().nonnegative(),
    }),
    createdAt: z.iso.datetime(),
  })
  .describe("Held-out evidence for an automatic profile, produced by scripts/evaluate-decisions.ts from labelled cases kept apart from tuning.")
export type HeldOutReport = z.infer<typeof HeldOutReport>

export const AcceptanceProfile = z
  .strictObject({
    mode: z.enum(["review", "automatic"]),
    model: ModelId.optional().describe("The model the thresholds were evaluated on. Required for automatic."),
    questionSet: VersionedName.optional().describe("The question set the thresholds were evaluated on. Required for automatic."),
    rules: AcceptanceRules.default({}),
    maxFalseAcceptRate: Decimal.optional().describe("The highest held-out false-accept rate (false accepts / accepts) the task tolerates, such as 0.01. Required for automatic."),
    report: HeldOutReport.optional(),
  })
  .describe("A versioned acceptance profile. Thresholds belong to the task and its consequences, not to the provider.")
export type AcceptanceProfile = z.infer<typeof AcceptanceProfile>

export const QuestionSet = z.strictObject({ questions: z.record(Key, QuestionInput) }).describe("A versioned question set: its labels and option order are part of its version.")
export type QuestionSet = z.infer<typeof QuestionSet>

/** The digest of a question set's exact questions: labels, prompts and option order. */
export const questionSetDigest = (set: QuestionSet) => `sha256:${createHash("sha256").update(canonical(set.questions)).digest("hex")}`

/** Why an automatic profile cannot be trusted, or undefined when its report backs it. Used when options load. */
export function automaticProblem(name: string, profile: AcceptanceProfile, sets: Readonly<Record<string, QuestionSet>>): string | undefined {
  if (profile.mode !== "automatic") return undefined
  const report = profile.report
  if (!profile.model || !profile.questionSet || profile.maxFalseAcceptRate === undefined || !report) return "an automatic profile needs model, questionSet, maxFalseAcceptRate and a held-out report"
  const set = new Map(Object.entries(sets)).get(profile.questionSet)
  if (!set) return `its question set ${profile.questionSet} is not configured`
  if (report.profile !== name || report.model !== profile.model || report.questionSet !== profile.questionSet) return "its report is for another profile, model or question set"
  if (report.questionSetDigest !== questionSetDigest(set)) return "its question set changed since the report: re-evaluate it"
  if (canonical(report.thresholds) !== canonical(profile.rules)) return "its thresholds are not the ones the report evaluated"
  if (report.dataset.heldOut < MIN_HELD_OUT || report.heldOut.answers < MIN_HELD_OUT) return `its report rests on fewer than ${MIN_HELD_OUT} held-out cases`
  if (report.heldOut.accepted === 0) return "its report accepted nothing on held-out data"
  const counts = report.heldOut
  if (counts.accepted + counts.reviewed + counts.refused !== counts.answers || counts.falseAccepts > counts.accepted) return "its report's counts do not add up"
  // falseAccepts / accepted <= max, in exact integers: max is a decimal in 10^-12 units.
  if (BigInt(counts.falseAccepts) * 10n ** 12n > money(profile.maxFalseAcceptRate).units * BigInt(counts.accepted)) return "its held-out false-accept rate is above maxFalseAcceptRate"
  return undefined
}

/** The profile a call runs under: the built-in review-first one, or a configured one by name. */
export interface ResolvedProfile {
  readonly name: string
  readonly profile: AcceptanceProfile
}
export const REVIEW_FIRST: AcceptanceProfile = { mode: "review", rules: {} }

type Answer = z.infer<typeof DecidedAnswer>
/** An answer before acceptance, for each question type (Omit over a union, distributed). */
export type Unaccepted = Answer extends unknown ? (Answer extends infer A ? (A extends unknown ? Omit<A, "acceptance"> : never) : never) : never
type Question = z.infer<typeof QuestionInput>
type Result = z.infer<typeof Acceptance>
type Reason = (typeof ACCEPTANCE_REASONS)[number]

/** The top two reported probabilities of a distribution, as reported. */
function top(distribution: Readonly<Record<string, number>>) {
  const ranked = Object.entries(distribution).sort(([, a], [, b]) => b - a)
  return { label: ranked[0]?.[0], first: ranked[0]?.[1], second: ranked[1]?.[1] ?? 0 }
}

/**
 * The acceptance of one answer. `context` is what the call actually ran with; an automatic profile whose report was
 * for anything else reviews instead of accepting.
 */
export function accept(
  answer: Unaccepted,
  question: Question,
  resolved: ResolvedProfile,
  context: { readonly model: string; readonly questionSet?: { readonly name: string; readonly digest: string }; readonly truncated: boolean },
): Result {
  if (answer.refusal !== undefined) return { disposition: "refused", reasons: ["REFUSED"] }
  const reasons = new Set<Reason>()
  const review = (): Result => ({ disposition: "review", reasons: [...reasons].sort() })
  if (context.truncated) reasons.add("PROVIDER_TRUNCATED")
  const { profile } = resolved
  if (profile.mode !== "automatic") reasons.add("CALIBRATION_UNAVAILABLE")
  else if (profile.model !== context.model || !context.questionSet || profile.questionSet !== context.questionSet.name || profile.report?.questionSetDigest !== context.questionSet.digest)
    reasons.add("CALIBRATION_MISMATCH")

  let outcome: boolean | string | undefined
  switch (answer.type) {
    case "noul": {
      if (answer.probability === undefined) reasons.add("CONFIDENCE_MISSING")
      else if (profile.rules.noul) {
        const { accept: threshold } = profile.rules.noul
        if (answer.probability >= threshold) outcome = true
        else if (answer.probability <= 1 - threshold) outcome = false
        else reasons.add("LOW_PROBABILITY")
      }
      break
    }
    case "choice": {
      if (answer.distribution === undefined) reasons.add("CONFIDENCE_MISSING")
      else if (profile.rules.choice) {
        const best = top(answer.distribution)
        if (best.label !== answer.choice) reasons.add("INCONSISTENT")
        else if (best.first === undefined || best.first < profile.rules.choice.minProbability) reasons.add("LOW_PROBABILITY")
        else if (profile.rules.choice.minMargin !== undefined && best.first - best.second < profile.rules.choice.minMargin) reasons.add("AMBIGUOUS")
        else outcome = best.label
      }
      break
    }
    case "score": {
      if (answer.distribution === undefined) reasons.add("CONFIDENCE_MISSING")
      else if (profile.rules.score) {
        const best = top(answer.distribution)
        if (best.first === undefined || best.first < profile.rules.score.minProbability) reasons.add("LOW_PROBABILITY")
        else outcome = best.label
      }
      break
    }
  }
  if (question.type !== answer.type) reasons.add("INCONSISTENT")
  const hasRule = answer.type === "noul" ? !!profile.rules.noul : answer.type === "choice" ? !!profile.rules.choice : !!profile.rules.score
  if (!hasRule && profile.mode === "automatic") reasons.add("CALIBRATION_UNAVAILABLE")
  if (reasons.size > 0 || outcome === undefined) return review()
  return { disposition: "accepted", outcome, reasons: [] }
}
