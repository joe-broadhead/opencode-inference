import * as z from "zod"
import type { Config } from "./config.js"
import { CapabilitiesInput, Exclusion, FIELD_TYPES, ModelId, OPERATIONS, ProfileName, QUESTION_TYPES, type Operation } from "./contracts.js"
import { METHOD_CLASSES, MODULES, type MethodClass, type Module } from "./ids.js"
import { OPERATION_MODULE } from "./routing.js"
import { CapabilityFixture, fixtureAgeDays, RouteCapability, STALE_AFTER_DAYS } from "../providers/openrouter/capabilities.js"

// The capabilities answer: what this version implements, what the reviewed fixture documents for each route, why each
// route cannot run, and the trusted limits. Local only.

export const CapabilitiesResult = z.strictObject({
  schemaVersion: z.literal(1),
  fixture: CapabilityFixture.omit({ routes: true }).extend({
    ageDays: z.number().int().nonnegative(),
    stale: z.boolean().describe(`True after ${STALE_AFTER_DAYS} days: routes may have changed since review.`),
  }),
  operations: z.array(
    z.strictObject({
      name: z.enum(OPERATIONS),
      tool: z.string().max(64),
      class: z.enum(METHOD_CLASSES),
      module: z.enum(MODULES),
      moduleEnabled: z.boolean(),
      implemented: z.boolean().describe("False: the tool is not registered in this version; plan describes it, nothing runs it."),
      acceptedFieldTypes: z.array(z.enum(FIELD_TYPES)).max(FIELD_TYPES.length).optional(),
      acceptedQuestionTypes: z.array(z.enum(QUESTION_TYPES)).max(QUESTION_TYPES.length).optional(),
    }),
  ).max(8),
  routes: z.array(
    RouteCapability.extend({
      profiles: z.array(ProfileName).max(32).describe("Configured profiles that name this model."),
      available: z.boolean(),
      reasons: z.array(Exclusion).max(16),
    }),
  ).max(32),
  profiles: z.array(z.strictObject({ name: ProfileName, model: ModelId, operation: z.enum(OPERATIONS).nullable().describe("null: the model is not in the reviewed fixture.") })).max(32),
  limits: z.strictObject({
    concurrency: z.number().int().positive(),
    maxFields: z.number().int().positive(),
    deadlineMs: z.number().int().positive(),
    spend: z.strictObject({ requestUsd: z.string(), sessionUsd: z.string(), rolling24hUsd: z.string(), requirePricedRoute: z.boolean(), requireUpperBound: z.boolean() }),
    requireZdr: z.boolean(),
  }),
  routing: z.strictObject({ mode: z.literal("explicit"), fallbacks: z.array(z.string()).max(0) }),
})
export type CapabilitiesResult = z.infer<typeof CapabilitiesResult>

/** An operation a later release implements. Its class covers its worst branch: cloud inference sends content and can spend. */
export interface OperationInfo {
  readonly name: Operation
  readonly tool: string
  readonly class: MethodClass
  readonly module: Module
}

export interface CapabilitiesContext {
  readonly config: Config
  readonly fixture: CapabilityFixture
  readonly operations: readonly OperationInfo[]
  readonly implemented: (operation: Operation) => boolean
  readonly now: Date
}

export function capabilities(input: z.infer<typeof CapabilitiesInput>, context: CapabilitiesContext): CapabilitiesResult {
  const { config, fixture, now } = context
  const { routes, ...meta } = fixture
  const ageDays = fixtureAgeDays(fixture, now)
  const profileEntries = Object.entries(config.profiles)
  const reasonsFor = (route: RouteCapability) => {
    const reasons: z.infer<typeof Exclusion>[] = []
    if (route.status === "unconfirmed") reasons.push("ROUTE_UNCONFIRMED")
    if (!route.enabled) reasons.push("ROUTE_DISABLED")
    if (!context.implemented(route.operation)) reasons.push("NOT_IMPLEMENTED")
    if (!config.modules[OPERATION_MODULE[route.operation]]) reasons.push("MODULE_DISABLED")
    if ((config.spend.requirePricedRoute && route.pricing === null) || (config.spend.requireUpperBound && route.pricing?.upperBound !== true)) reasons.push("PRICE_UNKNOWN")
    if (config.data.requireZdr && route.zdr !== "supported") reasons.push("ZDR_UNKNOWN")
    return reasons
  }
  return {
    schemaVersion: 1,
    fixture: { ...meta, ageDays, stale: ageDays > STALE_AFTER_DAYS },
    operations: context.operations
      .filter((operation) => input.operation === undefined || operation.name === input.operation)
      .map((operation) => ({
        name: operation.name,
        tool: operation.tool,
        class: operation.class,
        module: operation.module,
        moduleEnabled: config.modules[operation.module],
        implemented: context.implemented(operation.name),
        ...(operation.name === "extract" ? { acceptedFieldTypes: [...FIELD_TYPES] } : {}),
        ...(operation.name === "decide" ? { acceptedQuestionTypes: [...QUESTION_TYPES] } : {}),
      })),
    routes: routes
      .filter((route) => (input.operation === undefined || route.operation === input.operation) && (input.model === undefined || route.model === input.model))
      .map((route) => {
        const reasons = reasonsFor(route)
        return { ...route, profiles: profileEntries.filter(([, profile]) => profile.model === route.model).map(([name]) => name), available: reasons.length === 0, reasons }
      }),
    profiles: profileEntries.map(([name, profile]) => ({ name, model: profile.model, operation: routes.find((route) => route.model === profile.model)?.operation ?? null })),
    limits: { ...config.limits, spend: { ...config.spend }, requireZdr: config.data.requireZdr },
    routing: { mode: "explicit", fallbacks: [] },
  }
}
