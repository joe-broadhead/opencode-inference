import { capabilities, type CapabilitiesResult } from "../domain/capabilities.js"
import { CapabilitiesInput } from "../domain/contracts.js"
import { implemented, OPERATION_INFO } from "../domain/registry.js"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { HandlerDeps } from "./deps.js"
import { fail } from "./failures.js"
import { parsed } from "./input.js"
import { CAPABILITIES_INPUT, CAPABILITIES_OUTPUT } from "./schemas.js"

const DESCRIPTION =
  "List what this version implements and what each reviewed OpenRouter route documents: inputs, field and question kinds, limits, price when known and why it cannot run now. Filter by operation (extract, decide, read) or model. The data is a dated, documentation-derived fixture; nothing is refreshed or called."

export function capabilitiesHandler(deps: HandlerDeps): MethodHandler {
  return {
    description: DESCRIPTION,
    input: CAPABILITIES_INPUT,
    output: CAPABILITIES_OUTPUT,
    async run(raw) {
      try {
        const input = parsed(CapabilitiesInput, raw)
        return capabilities(input, {
          config: deps.config,
          fixture: deps.fixture,
          operations: OPERATION_INFO,
          implemented,
          now: (deps.now ?? (() => new Date()))(),
        }) satisfies CapabilitiesResult
      } catch (error) {
        fail(error)
      }
    },
  }
}
