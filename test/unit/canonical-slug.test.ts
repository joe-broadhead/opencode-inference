// An answer names its model by the catalog's dated canonical slug (cloudflare/clairic-20261029 for cloudflare/clairic,
// as the live canary of 2026-11-12 showed). Each adapter accepts exactly the route's model id or its reviewed canonical
// slug: never a prefix, another date, another model, or any slug on a route whose slug is not reviewed.
import { expect, test } from "bun:test"
import { loadConfig } from "../../src/domain/config.js"
import { DecideInput, ExtractInput } from "../../src/domain/contracts.js"
import { OPENROUTER_CAPABILITIES, type RouteCapability } from "../../src/providers/openrouter/capabilities.js"
import { decisionsAdapter } from "../../src/providers/openrouter/decisions.js"
import { extractionsAdapter } from "../../src/providers/openrouter/extractions.js"
import { snapshot, type FileAccess } from "../../src/runtime/sources.js"

const route = (model: string) => OPENROUTER_CAPABILITIES.routes.find((item) => item.model === model)!
const TEXT = "Total EUR 1.00"

test("the fixture records the reviewed canonical slugs from the catalog (source C1), and none for unreviewed routes", () => {
  expect(Object.fromEntries(OPENROUTER_CAPABILITIES.routes.map((item) => [item.model, item.canonicalSlug]))).toEqual({
    "cloudflare/clairic": "cloudflare/clairic-20261029",
    "scaledown/extract": "scaledown/extract-20260928",
    "inception/mercury-decide": null,
    "levanto/sage-2": null,
    "typesafe/jev-1.14": "typesafe/jev-1.14-20261014",
  })
  expect(OPENROUTER_CAPABILITIES.sources.map((source) => source.id)).toContain("C1")
})

/** Whether the adapter refused the answer as coming from another model (it may refuse it later for other reasons). */
const refusalOf = async (kind: "extract" | "decide", capability: RouteCapability, model: string | undefined) => {
  const source = await snapshot({ kind: "text", text: TEXT }, {} as FileAccess, capability, new AbortController().signal)
  const response = { status: 200, contentType: "application/json", body: new TextEncoder().encode(JSON.stringify({ model, answers: {} })), elapsedMs: 1 }
  // The input must be valid, or the test would pass without reaching the model check.
  try {
    if (kind === "extract") extractionsAdapter.parse(response, { source, route: capability, input: ExtractInput.parse({ model: capability.model, source: { kind: "text", text: TEXT }, fields: { total: { type: "number" } } }) })
    else {
      const input = decisionsAdapter.prepare!(DecideInput.parse({ model: capability.model, source: { kind: "text", text: TEXT }, questions: { paid: { type: "noul", prompt: "Paid?" } } }), loadConfig({}))
      decisionsAdapter.parse(response, { source, route: capability, input })
    }
    return ""
  } catch (error) {
    expect((error as { code?: string }).code).toBe("PROVIDER_CONTRACT_CHANGED")
    return String((error as Error).message)
  }
}
const fromAnotherModel = async (kind: "extract" | "decide", capability: RouteCapability, model: string) => (await refusalOf(kind, capability, model)).includes("the answer came from another model")

test("each adapter accepts exactly the model id or its reviewed canonical slug", async () => {
  const cases: ["extract" | "decide", RouteCapability, string, boolean][] = [
    ["extract", route("cloudflare/clairic"), "cloudflare/clairic", false],
    ["extract", route("cloudflare/clairic"), "cloudflare/clairic-20261029", false],
    ["extract", route("cloudflare/clairic"), "cloudflare/clairic-20261130", true],
    ["extract", route("cloudflare/clairic"), "cloudflare/clairic-2026", true],
    ["extract", route("cloudflare/clairic"), "cloudflare/clairic-20261029x", true],
    ["extract", route("cloudflare/clairic"), "scaledown/extract-20260928", true],
    ["extract", route("cloudflare/clairic"), "~cloudflare/clairic-latest", true],
    // A route with no reviewed slug accepts only its id.
    ["extract", route("levanto/sage-2"), "levanto/sage-2", false],
    ["extract", route("levanto/sage-2"), "levanto/sage-2-20261101", true],
    ["decide", route("typesafe/jev-1.14"), "typesafe/jev-1.14-20261014", false],
    ["decide", route("typesafe/jev-1.14"), "typesafe/jev-1.13-20260917", true],
    ["decide", route("typesafe/jev-1.14"), "typesafe/jev-1.14-20261201", true],
  ]
  for (const [kind, capability, model, refused] of cases) expect({ kind, model, refused: await fromAnotherModel(kind, capability, model) }).toEqual({ kind, model, refused })
})

test("an answer without a model is refused: both API references require it", async () => {
  expect(await refusalOf("extract", route("cloudflare/clairic"), undefined)).toMatch(/: model is missing\./)
  expect(await refusalOf("decide", route("typesafe/jev-1.14"), undefined)).toMatch(/: model is missing\./)
})
