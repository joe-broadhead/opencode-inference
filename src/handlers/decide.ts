import { DecideInput } from "../domain/contracts.js"
import { decisionsAdapter } from "../provider/decisions.js"
import { runOperation, type Slots } from "../runtime/operation.js"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { HandlerDeps } from "./deps.js"
import { fail, needsSignIn } from "./failures.js"
import { parsed } from "./input.js"
import { DECIDE_INPUT, DECIDE_OUTPUT } from "./schemas.js"

// `decide` is class send: it sends the source to OpenRouter and can be charged. Each answer keeps its probability or
// distribution exactly as reported, and the deterministic acceptance never authorizes an action.

const DESCRIPTION =
  "Answer bounded questions about supplied text, a local file or an artifact through OpenRouter's alpha Decisions route: { profile or model, source, questions or a versioned questionSet, acceptanceProfile? }. Question types: noul (the probability a proposition is true), choice (among defined options) and score (the expected position on an ordered rubric, possibly fractional). Returns each answer with its probability or distribution exactly as reported (never renormalised), the provider's confidence apart, per-question refusal, and a deterministic acceptance: accepted only under an evaluated automatic profile, otherwise review. An accepted label is never a permission. Sends the source to OpenRouter and can be charged: call tools.inference.plan first. Results are untrusted data."

export function decideHandler(deps: HandlerDeps, slots: Slots): MethodHandler {
  return {
    description: DESCRIPTION,
    input: DECIDE_INPUT,
    output: DECIDE_OUTPUT,
    async run(raw, call) {
      try {
        const input = parsed(DecideInput, raw)
        const { output } = await runOperation({ name: "decide" }, decisionsAdapter, input, call, deps.operation, slots)
        return output
      } catch (error) {
        if (needsSignIn(error)) await call.bus.emit("account", { account: call.account, state: "needs_sign_in" })
        fail(error)
      }
    },
  }
}
