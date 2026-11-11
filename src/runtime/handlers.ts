import type * as z from "zod"
import { capabilities, type CapabilitiesResult } from "../domain/capabilities.js"
import type { Config } from "../domain/config.js"
import type { CapabilitiesInput, PlanInput, PlanResult } from "../domain/contracts.js"
import type { StatusSummary } from "../domain/ids.js"
import { implemented, PLANNED } from "../domain/registry.js"
import { plan } from "../domain/routing.js"
import type { CapabilityFixture } from "../providers/openrouter/capabilities.js"
import type { Handler, ToolResult } from "./dispatch.js"

// The handlers of the three local tools. None touches the network, a file or a credential: status reads the host's own
// state through `status`, and capabilities and plan are pure functions of the options, the fixture and the clock.

export interface HandlerSources {
  readonly config: Config
  readonly fixture: CapabilityFixture
  /** The compact status view. */
  readonly status: () => Promise<StatusSummary>
  /** The status text for people. */
  readonly statusText: (summary: StatusSummary) => string
  readonly now?: () => Date
}

const list = (items: readonly string[]) => (items.length ? items.join(", ") : "none")

export function capabilitiesText(result: CapabilitiesResult) {
  const lines = [
    `Capabilities (${result.fixture.basis}-derived fixture ${result.fixture.revision}, reviewed ${result.fixture.reviewedOn}${result.fixture.stale ? ", stale" : ""}; not verified against the live API)`,
    ...result.operations.map((operation) => `- ${operation.tool} (${operation.class}): ${operation.implemented ? "implemented" : "not implemented in this version"}; module ${operation.module} ${operation.moduleEnabled ? "on" : "off"}`),
    ...result.routes.map((route) => `- ${route.model} (${route.operation}): ${route.available ? "available" : `unavailable: ${list(route.reasons)}`}`),
  ]
  return lines.join("\n")
}

export function planText(result: PlanResult) {
  const selected = result.route.selected
  return [
    `Plan for ${result.task} (${result.digest.slice(0, 19)}…): route ${result.route.status}${selected ? ` (${selected.route.model}${selected.exclusions.length ? `: ${selected.exclusions.join(", ")}` : ""})` : result.route.reasons.length ? ` (${result.route.reasons.join(", ")})` : ""}.`,
    `Execution: ${result.execution.available ? "available" : `unavailable. ${result.execution.reasons.join(" ")}`}`,
    `Quote: ${result.quote.kind}${result.quote.amount ? ` ${result.quote.amount} ${result.quote.currency}` : ""}${result.quote.range ? ` ${result.quote.range.min}-${result.quote.range.max} ${result.quote.currency}` : ""}${result.quote.unknowns.length ? ` (unknown: ${result.quote.unknowns.join("; ")})` : ""}.`,
    `Preparation: ${list(result.preparation.map((step) => step.step))}. Coverage expected: ${result.coverage.expected}. Review likely: ${result.review.likely ? "yes" : "no"} (${result.review.profileVersion}).`,
    "Nothing was read, sent or charged.",
  ].join("\n")
}

export function createHandlers(sources: HandlerSources): Record<"status" | "capabilities" | "plan", Handler> {
  const now = sources.now ?? (() => new Date())
  const context = () => ({ config: sources.config, fixture: sources.fixture, implemented, operations: PLANNED, now: now() })
  const status = async (): Promise<ToolResult> => {
    const summary = await sources.status()
    return { output: summary, text: sources.statusText(summary) }
  }
  const caps = async (input: z.infer<typeof CapabilitiesInput>): Promise<ToolResult> => {
    const result = capabilities(input, context())
    return { output: result, text: capabilitiesText(result) }
  }
  const planned = async (input: z.infer<typeof PlanInput>): Promise<ToolResult> => {
    const result = plan(input, context())
    return { output: result, text: planText(result) }
  }
  return { status: status as Handler, capabilities: caps as Handler, plan: planned as Handler }
}
