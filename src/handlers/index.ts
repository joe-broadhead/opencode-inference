import type { HandlerTable } from "@we-the-rebel-alliance/plugin-contract/register"
import { Slots } from "../runtime/operation.js"
import { capabilitiesHandler } from "./capabilities.js"
import { decideHandler } from "./decide.js"
import type { HandlerDeps } from "./deps.js"
import { extractHandler } from "./extract.js"
import { planHandler } from "./plan.js"
import { probeHandler } from "./probe.js"
import { statusHandler } from "./status.js"

// The one handler table `register` wires every door from (contract §9). Each method lives in its own file; this module
// only composes them. The concurrency slots are one budget for the whole plugin instance.

export function createHandlers(deps: HandlerDeps): HandlerTable {
  const slots = new Slots(deps.config.limits.concurrency)
  return {
    status: statusHandler(deps),
    probe: probeHandler(deps),
    capabilities: capabilitiesHandler(deps),
    plan: planHandler(deps),
    extract: extractHandler(deps, slots),
    decide: decideHandler(deps, slots),
  }
}

export type { HandlerDeps }
