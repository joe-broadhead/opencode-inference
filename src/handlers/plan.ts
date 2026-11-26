import { PlanInput } from "../domain/contracts.js"
import { implemented } from "../domain/registry.js"
import { plan } from "../domain/routing.js"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { HandlerDeps } from "./deps.js"
import { fail } from "./failures.js"
import { parsed } from "./input.js"
import { PLAN_INPUT, PLAN_OUTPUT_SCHEMA } from "./schemas.js"

// `plan` is a local quote and review. It is class read without `plans: true`: it mints no planId and commits nothing.
// It never opens a file, uploads, calls a provider or spends, and its answer is not a permission.

const DESCRIPTION =
  "Plan an extract, decide or read call without running it: { task, input } with the input you would pass. Returns the route and every reason it is ineligible, the local preparation needed, what would be sent and where, a quote (unavailable when no price is known; an estimate is never a ceiling), expected coverage, likely review and unknowns. It never opens a file, uploads, calls a provider or spends. A plan is not a permission."

export function planHandler(deps: HandlerDeps): MethodHandler {
  return {
    description: DESCRIPTION,
    input: PLAN_INPUT,
    output: PLAN_OUTPUT_SCHEMA,
    async run(raw) {
      try {
        const input = parsed(PlanInput, raw)
        return plan(input, {
          config: deps.config,
          fixture: deps.fixture,
          implemented,
          now: (deps.now ?? (() => new Date()))(),
        })
      } catch (error) {
        fail(error)
      }
    },
  }
}
