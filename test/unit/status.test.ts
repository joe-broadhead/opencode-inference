import { describe, expect, test } from "bun:test"
import * as z from "zod"
import { loadConfig } from "../../src/domain/config.js"
import type { StatusView } from "../../src/domain/ids.js"
import { StatusSchema, StatusSummarySchema } from "../../src/domain/status-schema.js"
import { connectionState } from "../../src/host/integration.js"
import { defaultRules } from "../../src/host/permissions.js"
import { buildStatus, keyRequired } from "../../src/host/status.js"
import { OPENROUTER_CAPABILITIES, type CapabilityFixture } from "../../src/providers/openrouter/capabilities.js"
import { AGENT_FIX, compactStatus, formatStatus, formatSummary, isStatus, NOTHING_TO_DO, STATUS_JSON_SCHEMA, statusLines } from "../../src/rpc.js"

const host = { version: "2.2.3", range: ">=2.2.3 <2.3.0", tested: true }
const base = (overrides: Partial<Parameters<typeof buildStatus>[0]> = {}) =>
  buildStatus({
    version: "0.0.0",
    host,
    config: loadConfig({}),
    fixture: OPENROUTER_CAPABILITIES,
    connectionState: async () => ({ state: "not_connected", next: "Run /connect and choose OpenRouter for Inference, then enter an OpenRouter API key." }),
    agents: async () => [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }, ...defaultRules()] }],
    problems: () => [],
    now: () => new Date("2026-11-12T00:00:00Z"),
    ...overrides,
  })

/** Drops what JSON Schema generators differ on but does not change meaning. */
function normal(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normal)
  if (!schema || typeof schema !== "object") return schema
  const { $schema: _, ...rest } = schema as Record<string, unknown>
  return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, key === "required" && Array.isArray(value) ? [...value].sort() : normal(value)]).sort(([a], [b]) => String(a).localeCompare(String(b))))
}

describe("the status contract", () => {
  test("the plain JSON Schema the TUI uses equals the server's zod schema", () => {
    const fromZod = z.toJSONSchema(StatusSchema, { io: "output" })
    expect(normal(STATUS_JSON_SCHEMA)).toEqual(normal(fromZod))
  })

  test("the shared fields come first, with the family's names", async () => {
    const view = await base()
    expect(Object.keys(view).slice(0, 5)).toEqual(["version", "host", "state", "unguardedAgents", "nextStep"])
    expect(StatusSchema.safeParse(view).success).toBe(true)
    expect(StatusSummarySchema.safeParse(compactStatus(view)).success).toBe(true)
    expect(isStatus(view)).toBe(true)
    expect(isStatus({ ...view, nextStep: undefined })).toBe(false)
  })
})

/** The committed fixture with every route disabled (and so unpriced), and with one route enabled (Sage, synthetic: never committed). */
const DISABLED: CapabilityFixture = { ...OPENROUTER_CAPABILITIES, routes: OPENROUTER_CAPABILITIES.routes.map((route) => ({ ...route, enabled: false, pricing: null })) }
const ONE_ENABLED = {
  ...DISABLED,
  routes: DISABLED.routes.map((route) =>
    route.model === "levanto/sage-2"
      ? { ...route, enabled: true, canary: { status: "passed" as const, on: "2026-11-12" }, pricing: { revision: "t", currency: "USD" as const, perRequest: "0.001", upperBound: true } }
      : route,
  ),
}

describe("the view", () => {
  test("with an enabled route and no key: the key is required, and connecting it is the next step", async () => {
    const view = await base({ fixture: ONE_ENABLED })
    expect(view).toMatchObject({ nextStep: "Run /connect and choose OpenRouter for Inference, then enter an OpenRouter API key.", connection: { state: "not_connected", required: true }, capabilities: { enabledRoutes: 1 } })
    expect(keyRequired(loadConfig({}), ONE_ENABLED)).toBe(true)
    // With the module that route serves turned off, the key is not needed again.
    expect(keyRequired(loadConfig({ modules: { extractions: false } }), ONE_ENABLED)).toBe(false)
  })

  test("with no route enabled and no key: local only, nothing to do, and the key is optional because no route sends", async () => {
    const view = await base({ fixture: DISABLED })
    expect(view).toMatchObject({
      state: "local_only",
      nextStep: NOTHING_TO_DO,
      connection: { integration: "inference-openrouter", state: "not_connected", required: false },
      tools: { registered: ["inference_status", "inference_capabilities", "inference_plan", "inference_extract", "inference_decide"], planned: ["inference_read"] },
      capabilities: { revision: OPENROUTER_CAPABILITIES.revision, reviewedOn: "2026-11-13", ageDays: 0, stale: false, routes: 5, enabledRoutes: 0 },
      spend: { currency: "USD", requestUsd: null, sessionUsd: null, rolling24hUsd: null, tracking: "none" },
      operations: { tracking: "none" },
    })
    expect(keyRequired(loadConfig({}), DISABLED)).toBe(false)
    expect(formatStatus(view)).toContain("no spend cap set; each call's result reports its cost")
  })

  test("the spend line names only the caps that are set", async () => {
    const view = await base({ config: loadConfig({ spend: { requestUsd: "0.05", rolling24hUsd: "5.00" } }) })
    expect(view.spend).toEqual({ currency: "USD", requestUsd: "0.05", sessionUsd: null, rolling24hUsd: "5.00", tracking: "none" })
    expect(formatStatus(view)).toContain("caps USD 0.05 per request, USD 5.00 per rolling 24 hours; each call's result reports its cost")
  })

  test("every module off is disabled", async () => {
    expect((await base({ config: loadConfig({ modules: { extractions: false, decisions: false, understanding: false } }) })).state).toBe("disabled")
  })

  test("an unguarded agent drives the next step with the fixed fix sentence, and /inference-status prints the block to paste", async () => {
    const view = await base({ config: loadConfig({ access: "ask-changes" }), agents: async () => [{ id: "reviewer", permissions: [{ action: "*", resource: "*", effect: "allow" }] }] })
    expect(view.unguardedAgents).toEqual(["reviewer"])
    expect(view.nextStep).toBe(AGENT_FIX)
    expect(formatStatus(view)).toContain(defaultRules("ask-changes").map((rule) => JSON.stringify(rule)).join(",\n  "))
    expect(formatSummary(compactStatus(view))).toContain("Agents without default rules: 1")
  })

  test("a problem comes before agents; the host's next step comes first of all", async () => {
    const problem = "RULES_NOT_ADDED: The default permission rules could not be added. Next step: Restart OpenCode."
    expect((await base({ problems: () => [problem] })).nextStep).toBe(problem)
    const outside = { ...host, version: "2.3.0", tested: false, next: "Outside the range." }
    expect((await base({ host: outside, problems: () => [problem] })).nextStep).toBe("Outside the range.")
  })

  test("a failing agent list does not fail status", async () => {
    expect((await base({ agents: async () => Promise.reject(new Error("boom")) })).unguardedAgents).toEqual([])
  })

  test("rows end with exactly one Next step, and status text is plain", async () => {
    const view: StatusView = await base()
    for (const lines of [statusLines(view, { paste: true }), statusLines(view, { paste: false, agents: "none" })]) {
      expect(lines.filter((line) => line.label === "Next step").length).toBe(1)
      expect(lines.at(-1)!.label).toBe("Next step")
      expect(lines.map((line) => line.label).slice(0, 3)).toEqual(["Connection", "Account", "Access"])
    }
    expect(formatStatus(view)).not.toMatch(/\u001b\[/)
  })
})

describe("the connection state", () => {
  const integration = (active: () => Promise<unknown>) => ({
    connection: {
      active,
      resolve: () => {
        throw new Error("the key must never be resolved by status")
      },
      status: async () => undefined,
    },
  })
  test("is connected, not connected, needs_auth or unknown, from the active connection alone", async () => {
    expect(await connectionState(integration(async () => ({ type: "credential" })) as never)).toEqual({ state: "connected" })
    expect((await connectionState(integration(async () => undefined) as never)).state).toBe("not_connected")
    expect((await connectionState(integration(async () => ({ type: "credential", status: { status: "needs_auth" } })) as never)).state).toBe("needs_auth")
    expect((await connectionState(integration(async () => Promise.reject(new Error("x"))) as never)).state).toBe("unknown")
  })
})
