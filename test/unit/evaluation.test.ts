// The evaluation harness: held-out counts from labelled cases and recorded answers, splits by document, and the report
// it produces is exactly what lets an automatic profile load and accept.
import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { accept, automaticProblem, questionSetDigest, type QuestionSet } from "../../src/domain/acceptance.js"
import { loadConfig } from "../../src/domain/config.js"
import { evaluate, type Dataset, type RecordedAnswers } from "../../src/domain/evaluation.js"
import { tempRoot } from "../support/temp.js"

const SET: QuestionSet = { questions: { paid: { type: "noul", prompt: "Has it been paid?" } } }
const RULES = { noul: { accept: 0.9 } }
const NOW = new Date("2026-11-12T00:00:00Z")

/** 10 tuning and 40 held-out cases, one per document. Held-out: 30 confident and right, 2 confident and wrong, 6 unsure, 2 refused. */
function fixture() {
  const cases: Dataset["cases"] = []
  const answers: RecordedAnswers["answers"] = {}
  for (let index = 0; index < 50; index++) {
    const id = `case-${index}`
    const split = index < 10 ? "tuning" : "held-out"
    const paid = index % 2 === 0
    cases.push({ id, document: `doc-${index}`, split, expected: { paid } })
    const held = index - 10
    const probability = split === "tuning" ? (paid ? 0.95 : 0.05) : held < 30 ? (paid ? 0.97 : 0.03) : held < 32 ? (paid ? 0.02 : 0.98) : 0.5
    answers[id] = { paid: held >= 38 ? { type: "noul", refusal: { reason: "unclear" } } : { type: "noul", probability: String(probability) } }
  }
  const dataset: Dataset = { revision: "paid-2026-11", cases }
  const recorded: RecordedAnswers = { model: "typesafe/jev-1.14", questionSet: "paid-v1", questionSetDigest: questionSetDigest(SET), answers }
  return { dataset, recorded }
}

describe("the held-out report", () => {
  test("counts held-out answers only: accepts, false accepts, reviews and refusals, and the noul Brier score", () => {
    const { dataset, recorded } = fixture()
    const result = evaluate({ profile: "paid-auto-v1", rules: RULES, questionSetName: "paid-v1", questionSet: SET, dataset, recorded, now: NOW })
    expect(result.report.heldOut).toEqual({ answers: 40, accepted: 32, falseAccepts: 2, reviewed: 6, refused: 2 })
    expect(result.report.dataset).toMatchObject({ revision: "paid-2026-11", tuning: 10, heldOut: 40 })
    expect(result.tuning).toEqual({ answers: 10, accepted: 10, falseAccepts: 0, reviewed: 0, refused: 0 })
    // (30 x 0.03^2 + 2 x 0.98^2 + 6 x 0.5^2) / 38 for the 38 answered held-out cases.
    expect(result.noulBrier).toBeCloseTo((30 * 0.03 ** 2 + 2 * 0.98 ** 2 + 6 * 0.25) / 38, 12)
  })

  test("the report lets the profile load and accept; a tighter false-accept limit refuses it", () => {
    const { dataset, recorded } = fixture()
    const { report } = evaluate({ profile: "paid-auto-v1", rules: RULES, questionSetName: "paid-v1", questionSet: SET, dataset, recorded, now: NOW })
    const profile = { mode: "automatic" as const, model: "typesafe/jev-1.14", questionSet: "paid-v1", rules: RULES, maxFalseAcceptRate: "0.07", report }
    // 2 false accepts in 32 is 0.0625.
    expect(automaticProblem("paid-auto-v1", profile, { "paid-v1": SET })).toBeUndefined()
    expect(automaticProblem("paid-auto-v1", { ...profile, maxFalseAcceptRate: "0.06" }, { "paid-v1": SET })).toMatch(/false-accept rate/)
    const config = loadConfig({ questionSets: { "paid-v1": SET }, acceptanceProfiles: { "paid-auto-v1": profile } })
    const resolved = { name: "paid-auto-v1", profile: config.acceptanceProfiles["paid-auto-v1"]! }
    expect(accept({ type: "noul", probability: "0.95" }, SET.questions.paid!, resolved, { model: "typesafe/jev-1.14", questionSet: { name: "paid-v1", digest: questionSetDigest(SET) }, truncated: false })).toEqual({ disposition: "accepted", outcome: true, reasons: [] })
  })

  test("refuses a document split across tuning and held-out, another question set's answers, and a missing answer", () => {
    const { dataset, recorded } = fixture()
    const run = (overrides: { dataset?: Dataset; recorded?: RecordedAnswers }) => () =>
      evaluate({ profile: "paid-auto-v1", rules: RULES, questionSetName: "paid-v1", questionSet: SET, dataset: overrides.dataset ?? dataset, recorded: overrides.recorded ?? recorded, now: NOW })
    const leaked = { ...dataset, cases: dataset.cases.map((item, index) => (index === 20 ? { ...item, document: "doc-0" } : item)) }
    expect(run({ dataset: leaked })).toThrow(/document doc-0 has cases in both splits/)
    expect(run({ recorded: { ...recorded, questionSetDigest: `sha256:${"0".repeat(64)}` } })).toThrow(/another question set/)
    const { "case-12": _gone, ...rest } = recorded.answers
    expect(run({ recorded: { ...recorded, answers: rest } })).toThrow(/case-12 has no recorded answer/)
    // A recorded acceptance is ignored: thresholds are applied afresh.
    const claimed = { ...recorded, answers: { ...recorded.answers, "case-45": { paid: { type: "noul", probability: "0.5", acceptance: { disposition: "accepted", outcome: true, reasons: [] } } } } }
    expect(evaluate({ profile: "paid-auto-v1", rules: RULES, questionSetName: "paid-v1", questionSet: SET, dataset, recorded: claimed, now: NOW }).report.heldOut.accepted).toBe(32)
  })

  test("the script prints the same report from files, and refuses without its inputs", () => {
    const dir = tempRoot("evaluate")
    const { dataset, recorded } = fixture()
    const write = (name: string, value: unknown) => (writeFileSync(join(dir, name), JSON.stringify(value)), join(dir, name))
    const options = write("options.json", { questionSets: { "paid-v1": SET }, acceptanceProfiles: { "paid-auto-v1": { mode: "review", questionSet: "paid-v1", rules: RULES } } })
    const script = new URL("../../scripts/evaluate-decisions.ts", import.meta.url).pathname
    const run = (args: string[]) => Bun.spawnSync([process.execPath, script, ...args], { stdout: "pipe", stderr: "pipe" })
    const ok = run(["--options", options, "--profile", "paid-auto-v1", "--dataset", write("dataset.json", dataset), "--answers", write("answers.json", recorded)])
    expect(ok.exitCode).toBe(0)
    expect(JSON.parse(ok.stdout.toString()).report.heldOut).toEqual({ answers: 40, accepted: 32, falseAccepts: 2, reviewed: 6, refused: 2 })
    const missing = run(["--options", options, "--profile", "paid-auto-v1"])
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr.toString()).toMatch(/--dataset is required/)
  }, 30_000)
})
