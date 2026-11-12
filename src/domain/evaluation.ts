import { createHash } from "node:crypto"
import * as z from "zod"
import { AcceptanceRules, applyRules, HeldOutReport, questionSetDigest, type QuestionSet, type Unaccepted } from "./acceptance.js"
import { canonical } from "./canonical.js"
import { DecidedAnswer, Key, ModelId, VersionedName } from "./contracts.js"

// The evaluation harness (handoff §17.2): measures a profile's thresholds on labelled cases and produces the held-out
// report an automatic profile needs. Pure: the cases and the recorded answers are passed in (scripts/evaluate-decisions.ts
// reads them from files; collecting answers live needs a key and spends, so it is a separate, opt-in step).
//
// - Thresholds are chosen on the tuning split; the report measures them on the HELD-OUT split only.
// - Splits are by DOCUMENT, not by case: a document with cases in both splits is refused, so chunks of one document
//   never leak from tuning into held-out.
// - A false accept is an accepted outcome that differs from the label. A refusal and a review are counted, never
//   scored as wrong or right. The Brier score is computed only for noul answers, which report a real probability.

export const LabelledCase = z.strictObject({
  id: z.string().min(1).max(128),
  document: z.string().min(1).max(128).describe("The source document. Splits are by document."),
  split: z.enum(["tuning", "held-out"]),
  expected: z.record(Key, z.union([z.boolean(), Key])).describe("The correct outcome per question: true or false for noul, an option or level id otherwise."),
})
export const Dataset = z.strictObject({ revision: z.string().min(1).max(128), cases: z.array(LabelledCase).min(1).max(100_000) })
export type Dataset = z.infer<typeof Dataset>

/** Answers recorded from runs of the question set, by case id then question key, without acceptance. */
export const RecordedAnswers = z.strictObject({
  model: ModelId,
  questionSet: VersionedName,
  questionSetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  answers: z.record(z.string().min(1).max(128), z.record(Key, z.unknown())),
})
export type RecordedAnswers = z.infer<typeof RecordedAnswers>

/** A recorded answer, checked with the answer schema; any acceptance it carries is ignored, never trusted. */
function recordedAnswer(raw: unknown, where: string): Unaccepted {
  const parsed = DecidedAnswer.safeParse({ ...(typeof raw === "object" && raw !== null ? raw : {}), acceptance: { disposition: "review", reasons: [] } })
  if (!parsed.success) throw new Error(`${where} is not a recorded answer`)
  const { acceptance: _ignored, ...answer } = parsed.data
  return answer as Unaccepted
}

export interface Counts {
  answers: number
  accepted: number
  falseAccepts: number
  reviewed: number
  refused: number
}

export interface Evaluation {
  readonly report: HeldOutReport
  readonly tuning: Counts
  /** Mean squared error of noul probabilities on held-out cases, or undefined with none. */
  readonly noulBrier?: number
}

export function evaluate(input: {
  readonly profile: string
  readonly rules: z.infer<typeof AcceptanceRules>
  readonly questionSetName: string
  readonly questionSet: QuestionSet
  readonly dataset: Dataset
  readonly recorded: RecordedAnswers
  readonly now: Date
}): Evaluation {
  const { dataset, recorded: run, questionSet } = input
  const digest = questionSetDigest(questionSet)
  if (run.questionSet !== input.questionSetName || run.questionSetDigest !== digest) throw new Error("the recorded answers are for another question set or version")
  const ids = new Set<string>()
  const splitOf = new Map<string, string>()
  for (const item of dataset.cases) {
    if (ids.has(item.id)) throw new Error(`case ${item.id} appears twice`)
    ids.add(item.id)
    const seen = splitOf.get(item.document)
    if (seen !== undefined && seen !== item.split) throw new Error(`document ${item.document} has cases in both splits`)
    splitOf.set(item.document, item.split)
  }
  const questions = new Map(Object.entries(questionSet.questions))
  const answersOf = new Map(Object.entries(run.answers))
  const zero = (): Counts => ({ answers: 0, accepted: 0, falseAccepts: 0, reviewed: 0, refused: 0 })
  const counts = { tuning: zero(), "held-out": zero() }
  let brierSum = 0
  let brierN = 0
  for (const item of dataset.cases) {
    const answers = new Map(Object.entries(answersOf.get(item.id) ?? {}))
    const tally = counts[item.split]
    for (const [key, expected] of Object.entries(item.expected)) {
      const question = questions.get(key)
      if (!question) throw new Error(`case ${item.id} labels ${key}, which the question set does not ask`)
      const raw = answers.get(key)
      if (raw === undefined) throw new Error(`case ${item.id} has no recorded answer for ${key}`)
      const answer = recordedAnswer(raw, `case ${item.id} ${key}`)
      tally.answers++
      if (answer.refusal !== undefined) {
        tally.refused++
        continue
      }
      if (item.split === "held-out" && answer.type === "noul" && answer.probability !== undefined && typeof expected === "boolean") {
        // A metric, not a decision: the float of the exact probability is fine here.
        brierSum += (Number(answer.probability) - (expected ? 1 : 0)) ** 2
        brierN++
      }
      const applied = applyRules(answer, question, input.rules)
      if (applied.outcome === undefined) tally.reviewed++
      else {
        tally.accepted++
        if (applied.outcome !== expected) tally.falseAccepts++
      }
    }
  }
  const heldOutCases = dataset.cases.filter((item) => item.split === "held-out").length
  const report = HeldOutReport.parse({
    schemaVersion: 1,
    profile: input.profile,
    model: run.model,
    questionSet: input.questionSetName,
    questionSetDigest: digest,
    thresholds: input.rules,
    dataset: { revision: dataset.revision, sha256: createHash("sha256").update(canonical(dataset)).digest("hex"), tuning: dataset.cases.length - heldOutCases, heldOut: heldOutCases },
    heldOut: counts["held-out"],
    createdAt: input.now.toISOString(),
  })
  return { report, tuning: counts.tuning, ...(brierN > 0 ? { noulBrier: brierSum / brierN } : {}) }
}
