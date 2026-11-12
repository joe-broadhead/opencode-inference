#!/usr/bin/env bun
// Measures an acceptance profile's thresholds on labelled cases and prints the held-out report an automatic profile
// needs (src/domain/evaluation.ts). Offline: it reads recorded answers and sends nothing. Collecting the answers needs
// an OpenRouter key and spends; do that separately and deliberately.
//
//   bun scripts/evaluate-decisions.ts --options <options.json> --profile <name> --dataset <dataset.json> --answers <answers.json>
//
// options.json is the plugin's options object: the profile's `rules` and `questionSet` and that question set are read
// from it. The report goes to stdout; put it in the profile's `report` (with mode "automatic", the model and a
// maxFalseAcceptRate) in a reviewed change. The options then load only if the report matches them.
import { readFileSync } from "node:fs"
import * as z from "zod"
import { AcceptanceRules, QuestionSet } from "../src/domain/acceptance.js"
import { Dataset, evaluate, RecordedAnswers } from "../src/domain/evaluation.js"

function refuse(reason: string): never {
  console.error(`evaluate-decisions: ${reason}`)
  console.error("usage: bun scripts/evaluate-decisions.ts --options <options.json> --profile <name> --dataset <dataset.json> --answers <answers.json>")
  process.exit(2)
}
const args = process.argv.slice(2)
const value = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const read = (name: string) => {
  const path = value(name)
  if (!path) refuse(`${name} is required`)
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown
  } catch {
    refuse(`${name} is not a readable JSON file`)
  }
}
const profileName = value("--profile")
if (!profileName) refuse("--profile is required")
const options = z
  .object({ questionSets: z.record(z.string(), QuestionSet), acceptanceProfiles: z.record(z.string(), z.object({ questionSet: z.string(), rules: AcceptanceRules })) })
  .safeParse(read("--options"))
if (!options.success) refuse("the options need questionSets and acceptanceProfiles with the profile's questionSet and rules")
const profile = new Map(Object.entries(options.data.acceptanceProfiles)).get(profileName)
if (!profile) refuse(`the options have no acceptance profile ${profileName}`)
const set = new Map(Object.entries(options.data.questionSets)).get(profile.questionSet)
if (!set) refuse(`the options have no question set ${profile.questionSet}`)
const dataset = Dataset.safeParse(read("--dataset"))
if (!dataset.success) refuse("the dataset does not match its schema")
const recorded = RecordedAnswers.safeParse(read("--answers"))
if (!recorded.success) refuse("the answers do not match their schema")
try {
  const result = evaluate({ profile: profileName, rules: profile.rules, questionSetName: profile.questionSet, questionSet: set, dataset: dataset.data, recorded: recorded.data, now: new Date() })
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  refuse((error as Error).message)
}
