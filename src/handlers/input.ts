import type * as z from "zod"
import { InferenceError } from "../domain/errors.js"

/** The input checked against its exact zod contract, or INPUT_INVALID naming each path and rule, never a value. */
export function parsed<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const checked = schema.safeParse(input)
  if (checked.success) return checked.data
  const problems = checked.error.issues.slice(0, 8).map((issue) => {
    const path = issue.path.length ? issue.path.map(String).join(".") : "input"
    return issue.code === "unrecognized_keys" ? `${path}: unknown keys ${issue.keys.map((key) => JSON.stringify(key)).join(", ")}` : `${path}: ${issue.message}`
  })
  throw new InferenceError("INPUT_INVALID", `The input is invalid: ${problems.join("; ")}.`)
}
