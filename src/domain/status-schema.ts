import * as z from "zod"
import { ACCESS_VALUES, CONNECTION_STATES, INTEGRATION_ID, STATES, type StatusSummary, type StatusView } from "./ids.js"

// Server only. The status RPC validates its answer with StatusSchema, and the status tool declares StatusSummarySchema
// as its output. The RPC contract itself is plain JSON Schema (src/rpc.ts), so the TUI bundle has no zod; a unit test
// keeps the two identical.
const text = (max: number) => z.string().max(max)
const next = text(4096).optional()
const module = z.strictObject({ enabled: z.boolean() })
const rule = z.strictObject({ action: text(128), resource: text(128), effect: z.enum(["allow", "ask", "deny"]) })

export const StatusSchema = z.strictObject({
  version: text(64),
  host: z.strictObject({ version: text(64).nullable(), range: text(64), tested: z.boolean(), next }),
  state: z.enum(STATES),
  unguardedAgents: z.array(text(256)).max(256),
  nextStep: text(4096),
  connection: z.strictObject({ integration: z.literal(INTEGRATION_ID), state: z.enum(CONNECTION_STATES), required: z.boolean(), next }),
  access: z.enum(ACCESS_VALUES),
  modules: z.strictObject({ extractions: module, decisions: module, understanding: module }),
  tools: z.strictObject({ registered: z.array(text(64)).max(32), planned: z.array(text(64)).max(32) }),
  capabilities: z.strictObject({
    revision: text(64),
    reviewedOn: text(10),
    ageDays: z.number().int().nonnegative(),
    stale: z.boolean(),
    basis: z.literal("documentation"),
    routes: z.number().int().nonnegative(),
    enabledRoutes: z.number().int().nonnegative(),
  }),
  spend: z.strictObject({ currency: z.literal("USD"), requestUsd: text(32), sessionUsd: text(32), rolling24hUsd: text(32), tracking: z.literal("none") }),
  operations: z.strictObject({ tracking: z.literal("none") }),
  permissions: z.strictObject({ block: z.array(rule).max(64) }),
  problems: z.array(text(1024)).max(8),
}) satisfies z.ZodType<StatusView>

/** The status tool's output: the unguarded agents are a count, and `nextStep` points to /inference-status for them. */
export const StatusSummarySchema = StatusSchema.extend({ unguardedAgents: z.number().int().nonnegative() }) satisfies z.ZodType<StatusSummary>
