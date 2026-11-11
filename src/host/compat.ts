import { InferenceError } from "../domain/errors.js"
import { HOST_RANGE, inRange, TESTED_TEXT, tested, type HostCheck } from "./versions.js"

/**
 * A tested release runs. Another release inside the range runs too, untested: the OpenCode row says so. Outside the
 * range setup refuses, unless `allowUntestedHost` is set; then the plugin runs with a warning as its next step.
 */
export function checkHost(found: string, allowUntestedHost: boolean): HostCheck {
  if (tested(found)) return { version: found, range: HOST_RANGE, tested: true }
  if (inRange(found)) return { version: found, range: HOST_RANGE, tested: false }
  if (!allowUntestedHost) throw new InferenceError("HOST_UNTESTED", `Inference supports OpenCode ${HOST_RANGE}; this is ${found}.`, `Use ${TESTED_TEXT}, or set the plugin option allowUntestedHost: true to run anyway.`)
  return { version: found, range: HOST_RANGE, tested: false, next: `This OpenCode version is outside ${HOST_RANGE} and runs only because allowUntestedHost is set. If something fails, use ${TESTED_TEXT}.` }
}
